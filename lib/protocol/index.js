// requires
const fs = require('fs');
const path = require('path');

const log = require('../logger');
const defParser = require('../parsers/def');
const { compile } = require('./compiler');

// constants
const PLATFORMS = ['pc', 'console', 'classic'];

function parseDefinitionFilename(file) {
    const parsedName = path.basename(file).match(/^(\w+)\.(\d+)(\.(\w+))?\.(def|js)$/);
    if (!parsedName) {
        if (file.endsWith('.def') || file.endsWith('.js'))
            log.warn(`[protocol] load (def) - invalid filename syntax "${path.basename(file)}"`);
        else
            log.debug(`[protocol] load (def) - skipping path "${path.basename(file)}"`);
        return null;
    }

    return {
        name: parsedName[1],
        version: parseInt(parsedName[2], 10),
        platform: parsedName[4],
        type: parsedName[5]
    };
}

function requireStr(data, filename) {
    // see https://stackoverflow.com/questions/17581830/load-node-js-module-from-string-in-memory
    const Module = require('module');

    if (typeof data !== 'string')
        throw Error('data must be string!');

    filename = filename || '';

    let m = new Module(filename, module.parent);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(data, filename);

    const exports = m.exports;
    if (module.parent && module.parent.children)
        module.parent.children.splice(module.parent.children.indexOf(m), 1);

    return exports;
};

// implementation
class TeraProtocol {
    constructor(region, majorPatchVersion, minorPatchVersion, protocolMap, platform = 'pc') {
        if (!PLATFORMS.includes(platform))
            throw new Error('Invalid platform!');

        this.region = region;
        this.majorPatchVersion = majorPatchVersion;
        this.minorPatchVersion = minorPatchVersion;
        this.platform = platform;
        this.protocolMap = protocolMap;
        this.messages = new Map();

        this.readBuffer = Buffer.allocUnsafe(0x10000);
        this.readViews = new Array(0x10000);
        for (let i = 0; i <= 0x10000; ++i)
            this.readViews[i] = new DataView(this.readBuffer.buffer, this.readBuffer.byteOffset, i);
        this.writeBuffer = Buffer.allocUnsafe(0x10000);
        this.writeView = new DataView(this.writeBuffer.buffer, this.writeBuffer.byteOffset, 0x10000);

        this.loaded = false;
    }

    _assignDeprecationFlags(name, version, definition) {
        definition.writeable = definition.readable = true;
        if (this.deprecationData[name] && this.deprecationData[name][version]) {
            const data = this.deprecationData[name][version];
            if ((!data.min || data.min > this.majorPatchVersion) && (!data.max || data.max < this.majorPatchVersion)) {
                definition.writeable = false;
                definition.readable = !!data['readable'];
            }
        }

        return definition;
    }

    parseDefinition(data) {
        return defParser(data);
    }

    addDefinition(name, version, definition, overwrite = false) {
        // Compile definition if required
        if (typeof definition.writer !== 'function' || typeof definition.reader !== 'function' || typeof definition.cloner !== 'function') {
            try {
                definition = compile(definition);
            } catch (e) {
                log.error(`[protocol] Error while compiling definition "${name}.${version}":`);
                log.error(e);
                return;
            }
        }

        // Add to map
        if (!this.messages.has(name))
            this.messages.set(name, new Map());
        if (overwrite || !this.messages.get(name).get(version))
            this.messages.get(name).set(version, this._assignDeprecationFlags(name, version, definition));
    }

    isDefaultDefinition(name, version) {
        return this.defaultDefinitions.has(`${name}.${version}`);
    }

    isCustomDefinition(name, version) {
        return !this.isDefaultDefinition(name, version);
    }

    load(dataPath) {
        this.loadDefaultBundle(JSON.parse(fs.readFileSync(path.join(dataPath, 'data.json'))));
        this.loadCustomDefinitions(path.join(dataPath, 'definitions'));
    }

    loadDefaultBundle(data) {
        // read deprecation data
        const defaultDefData = Object.keys(data.protocol).map(file => parseDefinitionFilename(file));
        this.lowestDefaultDefVersions = {};
        defaultDefData.forEach(def => {
            if (this.lowestDefaultDefVersions[def.name])
                this.lowestDefaultDefVersions[def.name] = Math.min(this.lowestDefaultDefVersions[def.name], def.version);
            else
                this.lowestDefaultDefVersions[def.name] = def.version;
        });

        this.deprecationData = data.deprecated || {};
        this.defaultDefinitions = new Set(defaultDefData.map(def => `${def.name}.${def.version}`));

        // reset messages
        this.messages.clear();

        // read protocol directory
        for (const file in data.protocol) {
            const parsedName = parseDefinitionFilename(file);
            const defData = Buffer.from(data.protocol[file], 'base64').toString('utf-8');

            // Always prefer platform-specific definition over default one!
            const definition = (parsedName.type === 'js') ? requireStr(defData, file) : defParser(file, defData);
            if (definition && (!parsedName.platform || parsedName.platform === this.platform))
                this.addDefinition(parsedName.name, parsedName.version, definition, !!parsedName.platform);
        }

        this.loaded = true;
    }

    loadCustomDefinitions(defPath) {
        const defFiles = fs.readdirSync(defPath);
        for (const file of defFiles) {
            const fullpath = path.join(defPath, file);
            const parsedName = parseDefinitionFilename(file);
            if (!parsedName)
                continue;

            if (parsedName.version !== 0 && this.lowestDefaultDefVersions[parsedName.name] && parsedName.version < this.lowestDefaultDefVersions[parsedName.name]) {
                log.debug(`Skipped loading outdated def ${parsedName.name}.${parsedName.version}! Consider cleaning your tera-data folder.`);
                continue;
            }

            // Always prefer platform-specific definition over default one!
            const definition = (parsedName.type === 'js') ? require(fullpath) : defParser(fullpath);
            if (definition && (!parsedName.platform || parsedName.platform === this.platform))
                this.addDefinition(parsedName.name, parsedName.version, definition, !!parsedName.platform);
        }
    }

    /**
     * Given an identifier, retrieve the name, opcode, and definition object.
     * @param {String|Number} identifier
     * @param {Number} [definitionVersion]
     * @returns Object An object with the `definition` property set, plus a `name` and `code`.
     * @throws {TypeError} `identifier` must be one of the listed types.
     * @throws Errors if supplied an opcode that could not be mapped to a `name`.
     * @throws Errors if a `definition` cannot be found.
     */
    resolveIdentifier(identifier, definitionVersion = '*') {
        const { protocolMap, messages } = this;
        let name;
        let code;
        let version;
        let definition;
        let latest_version;

        // Resolve code and name
        switch (typeof identifier) {
            case 'string': {
                name = identifier;
                if (!protocolMap.name.has(name))
                    throw new Error(`code not known for message "${name}"`);

                code = protocolMap.name.get(name);
                break;
            }

            case 'number': {
                code = identifier;
                if (!protocolMap.code.has(code))
                    throw new Error(`mapping not found for opcode ${code}`);

                name = protocolMap.code.get(code);
                break;
            }

            default:
                throw new TypeError('identifier must be a string or number');
        }

        // Resolve definition
        const versions = messages.get(name);
        if (versions) {
            latest_version = Math.max(...versions.keys());

            version = (definitionVersion === '*') ? latest_version : definitionVersion;
            definition = versions.get(version);
        }

        if (!definition) {
            if (latest_version && version && version < latest_version)
                throw new Error(`version ${version} of message (name: "${name}", code: ${code}) is outdated and cannot be used anymore`);
            else
                throw new Error(`no definition found for message (name: "${name}", code: ${code}, version: ${definitionVersion})`);
        }

        return { name, code, version, latest_version, definition };
    }

    /**
     * @param {Object} resolvedIdentifier
     * @param {Number} [definitionVersion]
     * @param {Buffer} buffer
     * @returns {Object}
     */
    parse(resolvedIdentifier, buffer) {
        if (!resolvedIdentifier.definition.readable)
            throw new Error(`version ${resolvedIdentifier.version} of message (name: "${resolvedIdentifier.name}", code: ${resolvedIdentifier.code}) is deprecated and cannot be used for reading`);

        buffer.copy(this.readBuffer, 0, 0, buffer.length);
        return resolvedIdentifier.definition.reader(this.readViews[buffer.length]);
    }

    /**
     * @param {Object} resolvedIdentifier
     * @param {Number|'*'} [definitionVersion]
     * @param {Object} data
     * @returns {Buffer}
     */
    write(resolvedIdentifier, data) {
        if (!resolvedIdentifier.definition.writeable)
            throw new Error(`version ${resolvedIdentifier.version} of message (name: "${resolvedIdentifier.name}", code: ${resolvedIdentifier.code}) is deprecated and cannot be used for writing`);

        // write data
        const length = resolvedIdentifier.definition.writer(this.writeView, data || {});

        // write header
        this.writeView.setUint16(0, length, true);
        this.writeView.setUint16(2, resolvedIdentifier.code, true);

        let result = Buffer.allocUnsafe(length);
        this.writeBuffer.copy(result, 0, 0, length);
        return result;
    }

    /**
     * @param {Object} resolvedIdentifier
     * @param {Object} data
     * @returns {Object}
     */
    clone(resolvedIdentifier, data) {
        return resolvedIdentifier.definition.cloner(data);
    }
}

module.exports = TeraProtocol;

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkArchivePolicy, readZip, crc32 } = require("../package.js");
const notice = "extension/THIRD-PARTY-NOTICES.md";
const binding = target => `extension/node_modules/@mcp-abap-adt/sap-rfc-lite/prebuilds/${target}/node.napi+sap-rfc-lite.node`;

test("archive policy accepts own prebuilds and rejects foreign bindings, SDK libraries and missing notices", () => {
    const cases = [];
    for (const target of ["win32-x64", "darwin-arm64"]) {
        cases.push([target, [notice, binding(target)], true]);
        cases.push([target, [notice, binding(target).replace("extension/node_modules/", "extension/node_modules/@mcp-abap-adt/connection/node_modules/")], true]);
        cases.push([target, [notice], false]);
        cases.push([target, [notice, binding(target), binding("linux-x64")], false]);
    }
    cases.push(["universal", [notice], true]);
    cases.push(["universal", [notice, binding("win32-x64")], false]);
    cases.push(["universal", [notice, "extension/node_modules/@mcp-abap-adt/sap-rfc-lite/package.json"], false]);
    cases.push(["universal", [], false]);
    for (const file of ["sapnwrfc.node", "sapnwrfc.dll", "libsapnwrfc.so", "libsapnwrfc.dylib", "libsapucum.so", "sapucum.dll", "icudt72.dll", "icudt72.dat", "icuin72.dll", "icuuc72.dll", "libicuuc.so.72", "libicudata.72.dylib"]) {
        for (const target of ["universal", "win32-x64", "darwin-arm64"]) {
            cases.push([target, [notice, ...(target === "universal" ? [] : [binding(target)]), `extension/sdk/${file}`], false]);
        }
    }
    cases.push(["universal", [notice, "extension/sapnwrfc.node.txt", "extension/sapnwrfc.dll.txt"], true]);
    for (const [target, names, expected] of cases) {
        if (expected) assert.doesNotThrow(() => checkArchivePolicy(names, target));
        else assert.throws(() => checkArchivePolicy(names, target));
    }
});

// Build tiny ZIP fixtures without npm, vsce, or filesystem side effects.
const { deflateRawSync } = require('node:zlib');
function fixture(method = 8, descriptor = false, junk = false) {
    const name = Buffer.from('extension/example.txt');
    const data = Buffer.from('packaged content '.repeat(20));
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const packed = junk ? Buffer.concat([compressed, Buffer.from('junk')]) : compressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(name.length, 26);
    if (!descriptor) {
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
    }
    const trailer = descriptor ? Buffer.alloc(descriptor === 'unsigned' ? 12 : 16) : Buffer.alloc(0);
    if (descriptor) {
        const start = descriptor === 'unsigned' ? 0 : 4;
        if (start) trailer.writeUInt32LE(0x08074b50);
        trailer.writeUInt32LE(crc32(data), start);
        trailer.writeUInt32LE(packed.length, start + 4);
        trailer.writeUInt32LE(data.length, start + 8);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(descriptor ? 8 : 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    const offset = local.length + name.length + packed.length + trailer.length;
    end.writeUInt32LE(offset, 16);
    return { zip: Buffer.concat([local, name, packed, trailer, central, name, end]), data, offset };
}

test('ZIP reader reads stored, deflated and data-descriptor entries', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    for (const method of [0, 8]) for (const descriptor of [false, true, 'unsigned']) {
        const { zip, data } = fixture(method, descriptor);
        assert.deepEqual(readZip(zip).get('extension/example.txt')(), data);
    }
});

test('ZIP reader rejects truncation, corrupt content, invalid sizes and unsupported formats', () => {
    const { zip, offset } = fixture();
    for (const length of [0, 10, zip.length - 1, zip.length - 22]) assert.throws(() => readZip(zip.subarray(0, length)));
    for (const [position, value] of [[offset + 16, 0], [offset + 20, 1], [offset + 24, 1]]) {
        const damaged = Buffer.from(zip);
        damaged.writeUInt32LE(value, position);
        assert.throws(() => { for (const read of readZip(damaged).values()) read(); });
    }
    for (const [position, value] of [[offset + 8, 1], [offset + 10, 99], [zip.length - 18, 1], [zip.length - 12, 65535]]) {
        const damaged = Buffer.from(zip);
        damaged.writeUInt16LE(value, position);
        assert.throws(() => readZip(damaged));
    }
    const damaged = Buffer.from(zip);
    damaged[50] ^= 0xff;
    assert.throws(() => { for (const read of readZip(damaged).values()) read(); });
});

test('ZIP reader rejects local CRC and size mismatches', () => {
    for (const method of [0, 8]) for (const position of [14, 18, 22]) {
        const { zip } = fixture(method);
        zip.writeUInt32LE((zip.readUInt32LE(position) + 1) >>> 0, position);
        assert.throws(() => readZip(zip), /Invalid or unsupported VSIX ZIP/);
    }
});

test('ZIP reader rejects incorrect or missing signed and unsigned data descriptors', () => {
    for (const method of [0, 8]) for (const descriptor of [true, 'unsigned']) {
        for (const field of [0, 4, 8]) {
            const { zip, offset } = fixture(method, descriptor);
            const position = offset - 12 + field;
            zip.writeUInt32LE((zip.readUInt32LE(position) + 1) >>> 0, position);
            assert.throws(() => readZip(zip), /Invalid or unsupported VSIX ZIP/);
        }
        const { zip, offset } = fixture(method, descriptor);
        zip.fill(0, offset - (descriptor === 'unsigned' ? 12 : 16), offset);
        assert.throws(() => readZip(zip), /Invalid or unsupported VSIX ZIP/);
    }
});

test('ZIP reader rejects trailing junk inside the declared DEFLATE size', () => {
    for (const descriptor of [false, true, 'unsigned']) {
        const { zip } = fixture(8, descriptor, true);
        assert.throws(() => readZip(zip).get('extension/example.txt')(), /Invalid or unsupported VSIX ZIP/);
    }
});

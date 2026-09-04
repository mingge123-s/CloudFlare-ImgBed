import assert from 'assert';
import {
    parseDavUploadPath,
    fileIdFromUploadSrc,
    lskyPublicBaseUrl,
    lskyWebDavBaseUri,
    davFileHref,
    davDirHref,
    isReservedKvKey,
} from '../functions/dav/webdavHelpers.js';

describe('WebDAV helpers for Lsky path stability', () => {
    it('rejects reserved KV keys that must not be DELETE/PUT via WebDAV', () => {
        assert.strictEqual(isReservedKvKey('manage@sysConfig@security'), true);
        assert.strictEqual(isReservedKvKey('manage@sysConfig@others'), true);
        assert.strictEqual(isReservedKvKey('chunk_upload_0'), true);
        assert.strictEqual(isReservedKvKey('upload_session_x'), true);
        assert.strictEqual(isReservedKvKey('multipart_x'), true);
        assert.strictEqual(isReservedKvKey('session@abc'), true);
        assert.strictEqual(isReservedKvKey('2026/09/04/photo.jpg'), false);
        assert.strictEqual(isReservedKvKey('lsky-test/hello.txt'), false);
    });

    it('parseDavUploadPath maps nested DAV path to origin upload folder+name', () => {
        const parsed = parseDavUploadPath('2026/09/03/photo.jpg');
        assert.strictEqual(parsed.uploadFolder, '2026/09/03');
        assert.strictEqual(parsed.fileName, 'photo.jpg');
        assert.strictEqual(parsed.expectedFileId, '2026/09/03/photo.jpg');
    });

    it('parseDavUploadPath keeps root-level file id identical to DAV relative path', () => {
        const parsed = parseDavUploadPath('hello.txt');
        assert.strictEqual(parsed.uploadFolder, '');
        assert.strictEqual(parsed.fileName, 'hello.txt');
        assert.strictEqual(parsed.expectedFileId, 'hello.txt');
    });

    it('parseDavUploadPath rejects directory-looking paths', () => {
        assert.throws(() => parseDavUploadPath('folder/'), /Invalid file name/);
        assert.throws(() => parseDavUploadPath(''), /Invalid file name/);
    });

    it('fileIdFromUploadSrc extracts id from absolute and relative src', () => {
        assert.strictEqual(
            fileIdFromUploadSrc('https://cloudflare-imgbed-3zr.pages.dev/file/2026/09/03/photo.jpg'),
            '2026/09/03/photo.jpg'
        );
        assert.strictEqual(fileIdFromUploadSrc('/file/hello.txt'), 'hello.txt');
    });

    it('Lsky config bases: base_uri=/dav/ and public url=/file/', () => {
        const site = 'https://cloudflare-imgbed-3zr.pages.dev';
        assert.strictEqual(lskyWebDavBaseUri(site), 'https://cloudflare-imgbed-3zr.pages.dev/dav/');
        assert.strictEqual(lskyPublicBaseUrl(site), 'https://cloudflare-imgbed-3zr.pages.dev/file/');
        // Lsky: public = strategy.url + pathname
        const pathname = '2026/09/03/photo.jpg';
        assert.strictEqual(
            lskyPublicBaseUrl(site) + pathname,
            'https://cloudflare-imgbed-3zr.pages.dev/file/2026/09/03/photo.jpg'
        );
    });

    it('PROPFIND hrefs always include /dav prefix', () => {
        assert.strictEqual(davFileHref('lsky-test/hello.txt'), '/dav/lsky-test/hello.txt');
        assert.strictEqual(davDirHref('lsky-test'), '/dav/lsky-test/');
        assert.strictEqual(davDirHref('/'), '/dav/');
        assert.strictEqual(davDirHref('dav/already'), '/dav/already/');
    });
});

/**
 * WebDAV 路径与公开 URL 辅助函数
 * 保证 Lsky 等客户端：PUT /dav/<rel> ↔ 公开 /file/<rel>
 */

/**
 * 从 DAV 相对路径解析上传参数（uploadNameType=origin 时 file id === fullPath）
 * @param {string} fullPath - 去掉 /dav 前缀后的路径，如 "2026/09/03/photo.jpg"
 * @returns {{ uploadFolder: string, fileName: string, expectedFileId: string }}
 */
export function parseDavUploadPath(fullPath) {
    if (!fullPath || fullPath.endsWith('/')) {
        throw new Error('Invalid file name');
    }

    const lastSlashIndex = fullPath.lastIndexOf('/');
    let uploadFolder = lastSlashIndex > -1 ? fullPath.substring(0, lastSlashIndex) : '';
    const fileName = lastSlashIndex > -1 ? fullPath.substring(lastSlashIndex + 1) : fullPath;

    if (uploadFolder) {
        if (/%[0-9a-fA-F]{2}/.test(uploadFolder)) {
            try {
                uploadFolder = decodeURIComponent(uploadFolder);
            } catch (e) {
                /* ignore */
            }
        }
        uploadFolder = uploadFolder
            .replace(/\.\./g, '_')
            .replace(/\\/g, '/')
            .replace(/\/{2,}/g, '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
    }

    const expectedFileId = uploadFolder ? `${uploadFolder}/${fileName}` : fileName;
    return { uploadFolder, fileName, expectedFileId };
}

/**
 * 从上传 API 返回的 src 提取 file id（/file/...）
 * @param {string} src
 * @returns {string|null}
 */
export function fileIdFromUploadSrc(src) {
    if (!src || typeof src !== 'string') return null;
    try {
        const pathname = src.startsWith('http') ? new URL(src).pathname : src;
        const match = pathname.match(/\/file\/(.+)$/);
        return match ? decodeURIComponent(match[1]) : null;
    } catch (e) {
        return null;
    }
}

/**
 * Lsky 公开 URL 基址：strategy.url 应指向 /file/，pathname 为 DAV 相对路径
 * @param {string} siteOrigin - 如 https://example.pages.dev
 * @returns {string}
 */
export function lskyPublicBaseUrl(siteOrigin) {
    const origin = siteOrigin.replace(/\/+$/, '');
    return `${origin}/file/`;
}

/**
 * WebDAV 根路径（Lsky base_uri）
 * @param {string} siteOrigin
 * @returns {string}
 */
export function lskyWebDavBaseUri(siteOrigin) {
    const origin = siteOrigin.replace(/\/+$/, '');
    return `${origin}/dav/`;
}

/**
 * PROPFIND 用的文件 href（带 /dav 前缀）
 * @param {string} fileName - KV 中的 file id
 * @returns {string}
 */
export function davFileHref(fileName) {
    const name = fileName.replace(/^\/+/, '');
    return `/dav/${name}`;
}

/**
 * PROPFIND 用的目录 href
 * @param {string} dir - 目录 id（可含或不含 dav/ 前缀）
 * @returns {string}
 */
export function davDirHref(dir) {
    if (!dir || dir === '/') return '/dav/';
    const clean = dir.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === 'dav' || clean.startsWith('dav/')) {
        return `/${clean}/`;
    }
    return `/dav/${clean}/`;
}

/**
 * WebDAV 路径与公开 URL 辅助函数
 * 保证 Lsky 等客户端：PUT /dav/<rel> ↔ 公开 /file/<rel>
 */

/** KV 中系统/内部键前缀，禁止作为 WebDAV 文件 id（与 list.js 过滤一致并扩展） */
const RESERVED_KEY_PREFIXES = [
    'manage@',
    'chunk_',
    'upload_session_',
    'multipart_',
    'session@',
];

/**
 * 反复 decodeURIComponent，直到稳定（防 %252e / %2540 双重编码绕过）
 * @param {string} value
 * @returns {string}
 */
export function fullyDecodeUriComponent(value) {
    if (!value || typeof value !== 'string') return '';
    let current = value;
    for (let i = 0; i < 5; i++) {
        if (!/%[0-9a-fA-F]{2}/.test(current)) break;
        try {
            const next = decodeURIComponent(current);
            if (next === current) break;
            current = next;
        } catch (e) {
            break;
        }
    }
    return current;
}

/**
 * 规范化 DAV 相对路径：充分解码 + 解析 . / ..，得到真实 KV file id
 * @param {string} relativePath - 已去掉 /dav 前缀的路径
 * @returns {string} 规范化后的相对路径（无首尾 /，目录可带尾 /）
 * @throws {Error} 路径非法或试图逃逸根目录
 */
export function normalizeDavRelativePath(relativePath) {
    if (relativePath == null || relativePath === '') {
        throw new Error('Invalid path');
    }
    let path = fullyDecodeUriComponent(String(relativePath));
    path = path.replace(/\\/g, '/');

    const isDir = path.endsWith('/');
    const parts = path.split('/');
    const stack = [];
    for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (stack.length === 0) {
                throw new Error('Invalid path');
            }
            stack.pop();
            continue;
        }
        // 段内再充分解码一次（防御段级双重编码）
        const decodedPart = fullyDecodeUriComponent(part);
        if (decodedPart === '' || decodedPart === '.') continue;
        if (decodedPart === '..') {
            if (stack.length === 0) throw new Error('Invalid path');
            stack.pop();
            continue;
        }
        stack.push(decodedPart);
    }

    if (stack.length === 0) {
        throw new Error('Invalid path');
    }

    const normalized = stack.join('/');
    return isDir ? `${normalized}/` : normalized;
}

/**
 * 是否为保留 KV 键（禁止 PUT/DELETE 覆盖或删除系统配置）
 * @param {string} fileId
 * @returns {boolean}
 */
export function isReservedKvKey(fileId) {
    if (!fileId || typeof fileId !== 'string') return true;
    let id;
    try {
        id = normalizeDavRelativePath(fileId.replace(/\/+$/, ''));
    } catch (e) {
        return true;
    }
    return RESERVED_KEY_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * 构造 /api/manage/delete/... URL：按段 encode，避免 URL 解析再次折叠 . / ..
 * @param {string} baseUrl - 任意同站 URL
 * @param {string} fileId - 已规范化的 file id
 * @returns {URL}
 */
export function buildManageDeleteUrl(baseUrl, fileId) {
    const encoded = fileId
        .split('/')
        .filter(Boolean)
        .map((seg) => encodeURIComponent(seg))
        .join('/');
    const url = new URL(baseUrl);
    url.pathname = `/api/manage/delete/${encoded}`;
    url.search = '';
    url.hash = '';
    return url;
}

/**
 * 与 uploadTools.sanitizeFileName 对齐（避免 WebDAV expectedFileId 与实际上传 id 漂移）
 * @param {string} fileName
 * @returns {string}
 */
export function sanitizeDavFileName(fileName) {
    let name = fullyDecodeUriComponent(fileName);
    name = name.split('/').pop();
    const unsafeCharsRe = /[\\\/:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/g;
    return name.replace(unsafeCharsRe, '_');
}

/**
 * 与 uploadTools.sanitizeUploadFolder 对齐
 * @param {string} folder
 * @returns {string}
 */
export function sanitizeDavUploadFolder(folder) {
    if (!folder || folder.trim() === '') {
        return '';
    }
    folder = fullyDecodeUriComponent(folder);
    // 与 upload 一致：任意位置的 .. 子串替换为 _
    folder = folder.replace(/\.\./g, '_');
    folder = folder.split('/').map((seg) => (seg === '.' ? '_' : seg)).join('/');
    folder = folder.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const segments = folder.split('/');
    return segments
        .map((seg) => seg.replace(/[\\:\*\?"'<>\| \(\)\[\]\{\}#%\^`~;@&=\+\$,]/g, '_'))
        .filter((seg) => seg.length > 0)
        .join('/');
}

/**
 * 从 DAV 相对路径解析上传参数（uploadNameType=origin 时 file id === fullPath）
 * @param {string} fullPath - 去掉 /dav 前缀后的路径，如 "2026/09/03/photo.jpg"
 * @returns {{ uploadFolder: string, fileName: string, expectedFileId: string }}
 */
export function parseDavUploadPath(fullPath) {
    const normalized = normalizeDavRelativePath(fullPath);
    if (!normalized || normalized.endsWith('/')) {
        throw new Error('Invalid file name');
    }

    const lastSlashIndex = normalized.lastIndexOf('/');
    let uploadFolder = lastSlashIndex > -1 ? normalized.substring(0, lastSlashIndex) : '';
    let fileName = lastSlashIndex > -1 ? normalized.substring(lastSlashIndex + 1) : normalized;

    // 与 /upload 的 sanitize 对齐，保证覆盖删除与公开 URL 使用同一 file id
    uploadFolder = sanitizeDavUploadFolder(uploadFolder);
    fileName = sanitizeDavFileName(fileName);
    if (!fileName) {
        throw new Error('Invalid file name');
    }

    const expectedFileId = uploadFolder ? `${uploadFolder}/${fileName}` : fileName;
    if (isReservedKvKey(expectedFileId)) {
        throw new Error('Forbidden path');
    }
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

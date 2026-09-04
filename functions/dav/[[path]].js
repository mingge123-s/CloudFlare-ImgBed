// WebDAV 服务支持
import { fetchOthersConfig } from "../utils/sysConfig";
import { getDatabase } from "../utils/databaseAdapter";
import { createApiToken, getTokenData } from "../api/manage/apiTokens";
import {
    parseDavUploadPath,
    fileIdFromUploadSrc,
    davFileHref,
    davDirHref,
    isReservedKvKey,
} from "./webdavHelpers.js";

export async function onRequest(context) {
    const { request, env } = context;

    // WebDAV 规范：根目录 /dav 无斜杠时重定向到 /dav/
    const url = new URL(request.url);
    if (url.pathname === '/dav') {
        url.pathname = '/dav/';
        return Response.redirect(url.toString(), 301);
    }

    const authResponse = await checkAuth(request, env);
    if (authResponse) return authResponse;

    // 从请求路径中替换第一个 /dav 部分
    url.pathname = url.pathname.replace(/^\/dav/, '') || '/';
    const modifiedRequest = new Request(url.toString(), request);

    switch (modifiedRequest.method) {
        case 'OPTIONS': return handleOptions(modifiedRequest);
        case 'PROPFIND': return handlePropfind(modifiedRequest, env);
        case 'PUT': return handlePut(modifiedRequest, env);
        case 'DELETE': return handleDelete(modifiedRequest, env);
        case 'GET': return handleGet(modifiedRequest, env);
        case 'MKCOL': return new Response(null, { status: 201 });
        default: return new Response('Method Not Allowed', { status: 405 });
    }
}

// --- UTILITY FUNCTIONS ---

/**
 * 内部调用 /upload 与 /api/manage/* 使用专用 API Token（Bearer），
 * 不再用 hashed adminPassword 拼 Basic Auth（v2.6+ 会导致 401）。
 */
async function getApiHeaders(env) {
    const othersConfig = await fetchOthersConfig(env);
    let token = othersConfig.webDAV?.internalToken;
    let tokenId = othersConfig.webDAV?.internalTokenId;

    const db = getDatabase(env);

    // 校验 token 仍存在于 security 配置中；缺失则重建
    if (token) {
        const tokenData = await getTokenData(db, token);
        if (!tokenData) {
            token = null;
            tokenId = null;
        }
    }

    if (!token) {
        const tokenResult = await createApiToken(
            db,
            'WebDAV Internal Token',
            ['list', 'upload', 'delete'],
            'system',
            null,
            false,
            'internal'
        );
        token = tokenResult.token;
        tokenId = tokenResult.id;

        const settingsStr = await db.get('manage@sysConfig@others');
        const settings = settingsStr ? JSON.parse(settingsStr) : {};
        if (!settings.webDAV) settings.webDAV = {};
        settings.webDAV.internalToken = token;
        settings.webDAV.internalTokenId = tokenId;
        await db.put('manage@sysConfig@others', JSON.stringify(settings));
    }

    return {
        'Authorization': `Bearer ${token}`,
    };
}

async function checkAuth(request, env) {
    const othersConfig = await fetchOthersConfig(env);

    const enabled = othersConfig.webDAV?.enabled;
    if (!enabled) return new Response('WebDAV is disabled', { status: 403 });

    const davUser = othersConfig.webDAV.username;
    const davPass = othersConfig.webDAV.password;
    if (!davUser || !davPass) return null; // No auth required

    const authHeader = request.headers.get('Authorization');
    if (!authHeader) {
        return new Response('Authorization required', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="WebDAV"' },
        });
    }

    const [scheme, encoded] = authHeader.split(' ');
    if (scheme !== 'Basic' || !encoded) {
        return new Response('Malformed Authorization header', { status: 400 });
    }

    const [user, pass] = atob(encoded).split(':');
    if (user !== davUser || pass !== davPass) {
        return new Response('Invalid credentials', { status: 403 });
    }

    return null;
}

// --- WEBDAV METHOD HANDLERS ---

function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            'Allow': 'OPTIONS, GET, PUT, DELETE, PROPFIND, MKCOL',
            'DAV': '1, 2',
            'MS-Author-Via': 'DAV',
        },
    });
}

async function handleGet(request, env) {
    const path = decodeURIComponent(new URL(request.url).pathname);

    if (path.endsWith('/')) { // Directory listing
        try {
            const dir = path === '/' ? '' : path.substring(1, path.length - 1);
            const contents = await fetchDirectoryContents(dir, env, request);
            const html = generateDirectoryListingHtml(path, contents);
            return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (error) {
            console.error('GET (directory) failed:', error.stack);
            return new Response(`Error listing directory: ${error.message}`, { status: 500 });
        }
    } else { // File download — DAV path 与 uploadNameType=origin 的 file id 一致
        try {
            const fileUrl = new URL(`/file${path}`, request.url);

            const fileResponse = await fetch(fileUrl.toString());

            if (!fileResponse.ok) {
                 return new Response('File not found', { status: fileResponse.status, statusText: fileResponse.statusText });
            }

            const response = new Response(fileResponse.body, fileResponse);
            response.headers.set('Access-Control-Allow-Origin', '*');

            return response;
        } catch (error) {
            console.error('GET (file) failed:', error.stack);
            return new Response(`Error getting file: ${error.message}`, { status: 500 });
        }
    }
}

async function handlePut(request, env) {
    const fullPath = decodeURIComponent(new URL(request.url).pathname.substring(1));
    let parsed;
    try {
        parsed = parseDavUploadPath(fullPath);
    } catch (e) {
        return new Response('Invalid file name', { status: 400 });
    }

    const { uploadFolder, fileName, expectedFileId } = parsed;

    // 禁止覆盖/删除系统 KV 键（如 manage@sysConfig@*）
    if (isReservedKvKey(expectedFileId)) {
        return new Response('Forbidden path', { status: 403 });
    }

    // 同路径覆盖：先删旧记录，保证 DAV path 仍映射到同一 file id（避免 origin 落到 name(1).ext）
    // 删除必须成功，否则 origin 命名会落到 name(1).ext，破坏 Lsky 路径约定
    try {
        const db = getDatabase(env);
        const existing = await db.getWithMetadata(expectedFileId);
        // 仅当存在文件元数据时视为可覆盖的图床文件（避免误伤无 Channel 的异常键）
        if (existing && existing.metadata && (existing.metadata.Channel || existing.metadata.TimeStamp)) {
            const deleteUrl = new URL(`/api/manage/delete/${expectedFileId}`, request.url);
            const deleteResponse = await fetch(deleteUrl.toString(), {
                method: 'DELETE',
                headers: await getApiHeaders(env)
            });
            let deleteResult = null;
            try {
                deleteResult = await deleteResponse.json();
            } catch (e) {
                /* non-JSON */
            }
            if (!deleteResponse.ok || !deleteResult?.success) {
                const msg = deleteResult?.error || `status ${deleteResponse.status}`;
                return new Response(`Overwrite failed: could not delete existing file (${msg})`, { status: 409 });
            }
        }
    } catch (e) {
        console.error('WebDAV overwrite pre-delete failed:', e.stack);
        return new Response(`Overwrite failed: ${e.message}`, { status: 500 });
    }

    const fileContent = await request.blob();
    const formData = new FormData();
    formData.append('file', fileContent, fileName);

    const uploadUrl = new URL(`/upload`, request.url);
    // 使用原始文件名，使 file id === DAV 相对路径，GET /dav/<path> → /file/<path>
    uploadUrl.searchParams.set('uploadNameType', 'origin');
    if (uploadFolder) {
        uploadUrl.searchParams.set('uploadFolder', uploadFolder);
    }

    const othersConfig = await fetchOthersConfig(env);
    const webdavConfig = othersConfig.webDAV || {};
    if (webdavConfig.uploadChannel) {
        uploadUrl.searchParams.set('uploadChannel', webdavConfig.uploadChannel);
    }
    if (webdavConfig.channelName) {
        uploadUrl.searchParams.set('channelName', webdavConfig.channelName);
    }

    try {
        const response = await fetch(uploadUrl.toString(), {
            method: 'POST',
            body: formData,
            headers: await getApiHeaders(env)
        });
        const result = await response.json();
        if (response.ok && Array.isArray(result) && result.length > 0 && result[0].src) {
            const publicSrc = result[0].src;
            const actualId = fileIdFromUploadSrc(publicSrc) || expectedFileId;
            const locationUrl = new URL(`/file/${actualId}`, request.url).toString();
            // Location：公开文件 URL（Pages /file/...，背后为 Telegram）
            // Content-Location：同路径 DAV URL，便于客户端核对 PUT path
            return new Response(null, {
                status: 201,
                headers: {
                    'Location': locationUrl,
                    'Content-Location': new URL(`/dav/${actualId}`, request.url).toString(),
                },
            });
        } else {
            const errorMsg = result.error || JSON.stringify(result);
            console.error('Upload API error:', errorMsg);
            return new Response(`Upload failed: ${errorMsg}`, { status: response.status || 500 });
        }
    } catch (error) {
        console.error('Fetch to upload API failed:', error.stack);
        return new Response('Failed to contact upload service', { status: 502 });
    }
}

async function handleDelete(request, env) {
    const path = decodeURIComponent(new URL(request.url).pathname.substring(1));
    if (!path) return new Response('Invalid path for DELETE', { status: 400 });

    const isFolder = path.endsWith('/');
    const cleanPath = isFolder ? path.slice(0, -1) : path;

    if (isReservedKvKey(cleanPath)) {
        return new Response('Forbidden path', { status: 403 });
    }

    const deleteUrl = new URL(`/api/manage/delete/${cleanPath}`, request.url);
    if (isFolder) deleteUrl.searchParams.set('folder', 'true');

    try {
        const response = await fetch(deleteUrl.toString(), {
            method: 'DELETE',
            headers: await getApiHeaders(env)
        });
        const result = await response.json();
        if (result.success) {
            return new Response(null, { status: 204 }); // No Content
        } else {
            console.error('Delete API error:', JSON.stringify(result));
            return new Response(`Deletion failed: ${result.error || 'API error'}`, { status: 500 });
        }
    } catch (error) {
        console.error('Delete operation failed:', error.stack);
        return new Response(`Internal server error: ${error.message}`, { status: 500 });
    }
}

async function handlePropfind(request, env) {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const depth = request.headers.get('Depth') || '1';

    try {
        const db = getDatabase(env);

        // 检查请求路径是否为文件
        let isFile = false;
        let fileInfo = null;
        if (path !== '/') {
            const cleanPath = path.startsWith('/') ? path.substring(1) : path;
            const fileData = await db.getWithMetadata(cleanPath);
            if (fileData && fileData.metadata) {
                isFile = true;
                fileInfo = {
                    name: cleanPath,
                    metadata: fileData.metadata
                };
            }
        }

        // 检查请求路径是否为目录
        let isDir = false;
        if (path === '/') {
            isDir = true;
        } else {
            const dir = path.startsWith('/') ? path.substring(1) : path;
            const cleanDir = dir.endsWith('/') ? dir : dir + '/';
            const listResponse = await db.list({ prefix: cleanDir, limit: 1 });
            if (listResponse.keys && listResponse.keys.length > 0) {
                isDir = true;
            }
        }

        // MKCOL 后的空目录：尚无文件时仍当作集合，避免客户端崩溃
        if (!isFile && !isDir) {
            if (path.endsWith('/') || depth === '0') {
                isDir = true;
            } else {
                return new Response('Not Found', { status: 404 });
            }
        }

        let xml;
        if (isFile) {
            xml = `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${createFileXml(fileInfo)}</D:multistatus>`;
        } else {
            const dir = path === '/' ? '' : path.substring(1, path.endsWith('/') ? path.length - 1 : path.length);
            let contents = { files: [], directories: [] };
            if (depth !== '0') {
                contents = await fetchDirectoryContents(dir, env, request);
            }
            xml = generateWebDAVXml(path, contents, depth);
        }

        return new Response(xml, { status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
    } catch (error) {
        console.error('Propfind failed:', error.stack);
        return new Response(`Failed to list files: ${error.message}`, { status: 500 });
    }
}

// --- API DATA FETCHING ---

async function fetchDirectoryContents(dir, env, request) {
    let allFiles = [];
    let allDirectories = [];
    const count = -1; // Fetch all items

    const listUrl = new URL(`/api/manage/list`, request.url);
    listUrl.searchParams.set('dir', dir);
    listUrl.searchParams.set('count', count);

    const response = await fetch(listUrl.toString(), { headers: await getApiHeaders(env) });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API fetch error: Status ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    if (result.error) {
        throw new Error(`API error: ${result.error} - ${result.message}`);
    }

    if (result.files && result.files.length > 0) allFiles = allFiles.concat(result.files);
    if (result.directories && result.directories.length > 0) allDirectories = allDirectories.concat(result.directories);

    return { files: allFiles, directories: [...new Set(allDirectories)] };
}

// --- HTML and XML GENERATION ---

function generateDirectoryListingHtml(basePath, contents) {
    let fileLinks = '';
    let dirLinks = '';

    for (const dir of contents.directories) {
        const fullDirPath = davDirHref(dir);
        const dirName = dir.split('/').pop();
        dirLinks += `<li><a href="${fullDirPath}"><strong>${dirName}/</strong></a></li>`;
    }

    for (const file of contents.files) {
        const fullFilePath = davFileHref(file.name);
        const fileName = file.name.split('/').pop();
        const fileSize = file.metadata && file.metadata['FileSize']
            ? `${file.metadata['FileSize']} MB`
            : 'N/A';
        fileLinks += `<li><a href="${fullFilePath}">${fileName}</a> - ${fileSize}</li>`;
    }

    let parentDirLink = '';
    if (basePath !== '/') {
        const parentPath = new URL('..', `http://dummy.com${basePath}`).pathname;
        parentDirLink = `<li><a href="/dav${parentPath}"><strong>../ (Parent Directory)</strong></a></li>`;
    }

    return `<!DOCTYPE html><html><head><title>Index of ${basePath}</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:sans-serif;padding:20px}li{margin:5px 0}</style></head><body><h1>Index of ${basePath}</h1><ul>${parentDirLink}${dirLinks}${fileLinks}</ul></body></html>`;
}

function generateWebDAVXml(basePath, contents, depth) {
    let responses = '';
    const prefixPath = basePath.startsWith('/dav/') ? basePath : `/dav${basePath.startsWith('/') ? '' : '/'}${basePath}`;
    const currentPath = prefixPath.endsWith('/') ? prefixPath : `${prefixPath}/`;

    responses += createCollectionXml(currentPath);

    if (depth !== '0') {
        for (const dir of contents.directories) {
            responses += createCollectionXml(davDirHref(dir));
        }
        for (const file of contents.files) {
            responses += createFileXml(file);
        }
    }
    return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

function createCollectionXml(path) {
    const now = new Date();
    const creationDate = now.toISOString();
    const lastModified = now.toUTCString();
    const pathWithSlash = path.endsWith('/') ? path : `${path}/`;
    const cleanPath = path.endsWith('/') ? path.slice(0, -1) : path;
    const name = cleanPath.split('/').pop() || '';
    return `<D:response><D:href>${encodeURI(pathWithSlash)}</D:href><D:propstat><D:prop><D:displayname>${name}</D:displayname><D:resourcetype><D:collection/></D:resourcetype><D:creationdate>${creationDate}</D:creationdate><D:getlastmodified>${lastModified}</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function createFileXml(file) {
    let fileSize = "0";
    if (file.metadata) {
        if (file.metadata['FileSizeBytes']) {
            fileSize = String(file.metadata['FileSizeBytes']);
        } else if (file.metadata['FileSize']) {
            fileSize = String(Math.round(parseFloat(file.metadata['FileSize']) * 1024 * 1024));
        }
    }
    const fileTime = file.metadata && file.metadata['TimeStamp']
        ? new Date(Number(file.metadata['TimeStamp']))
        : new Date();
    const creationDate = fileTime.toISOString();
    const lastModified = fileTime.toUTCString();
    const contentType = file.metadata && file.metadata['FileType'] ? file.metadata['FileType'] : "application/octet-stream";
    return `<D:response><D:href>${encodeURI(davFileHref(file.name))}</D:href><D:propstat><D:prop><D:displayname>${file.name.split('/').pop()}</D:displayname><D:resourcetype/><D:creationdate>${creationDate}</D:creationdate><D:getlastmodified>${lastModified}</D:getlastmodified><D:getcontentlength>${fileSize}</D:getcontentlength><D:getcontenttype>${contentType}</D:getcontenttype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

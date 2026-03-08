import { errorHandling, telemetryData } from "./utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        // 支持多文件上传
        const uploadFiles = formData.getAll('file');
        if (!uploadFiles || uploadFiles.length === 0) {
            throw new Error('No file uploaded');
        }

        const results = [];

        for (const uploadFile of uploadFiles) {
            // 只允许图片、视频、音频格式
            const isImage = uploadFile.type.startsWith('image/');
            const isVideo = uploadFile.type.startsWith('video/');
            const isAudio = uploadFile.type.startsWith('audio/');
            if (!isImage && !isVideo && !isAudio) {
                results.push({ error: `${uploadFile.name} 格式不支持，仅允许图片/视频/音频` });
                continue;
            }

            const fileName = uploadFile.name;
            const fileExtension = fileName.split('.').pop().toLowerCase();

            const telegramFormData = new FormData();
            telegramFormData.append("chat_id", env.TG_Chat_ID);

            let apiEndpoint;
            if (isImage) {
                telegramFormData.append("photo", uploadFile);
                apiEndpoint = 'sendPhoto';
            } else if (isAudio) {
                telegramFormData.append("audio", uploadFile);
                apiEndpoint = 'sendAudio';
            } else {
                telegramFormData.append("video", uploadFile);
                apiEndpoint = 'sendVideo';
            }

            const result = await sendToTelegram(telegramFormData, apiEndpoint, env);

            if (!result.success) {
                throw new Error(result.error);
            }

            const fileId = getFileId(result.data);

            if (!fileId) {
                throw new Error('Failed to get file ID for: ' + fileName);
            }

            // 将文件信息保存到 KV 存储
            if (env.img_url) {
                await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                    metadata: {
                        TimeStamp: Date.now(),
                        ListType: "None",
                        Label: "None",
                        liked: false,
                        fileName: fileName,
                        fileSize: uploadFile.size,
                    }
                });
            }

            const fileSrc = `/file/${fileId}.${fileExtension}`;
            results.push({ 'src': fileSrc });

            // 同步到图库（仅图片）
            console.log('[gallery] GALLERY_URL:', env.GALLERY_URL || 'NOT SET');
            console.log('[gallery] isImage:', isImage, 'type:', uploadFile.type);
            if (env.GALLERY_URL && isImage) {
                const imageUrl = `https://image.kont.us.ci${fileSrc}`;
                console.log('[gallery] calling syncToGallery with:', imageUrl);
                context.waitUntil(
                    syncToGallery(imageUrl, fileName, env)
                        .then(() => console.log('[gallery] sync OK'))
                        .catch(e => console.error('[gallery sync] failed:', e.message))
                );
            }
        }

        return new Response(
            JSON.stringify(results),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;

    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}

// ── 同步到图库 ─────────────────────────────────────────────────────────────────
async function syncToGallery(imageUrl, fileName, env) {
    const galleryUrl = env.GALLERY_URL.replace(/\/$/, '');
    const res = await fetch(`${galleryUrl}/gallery/save`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Password': env.GALLERY_PASSWORD || '',
        },
        body: JSON.stringify({
            imageUrl,
            prompt: fileName || '手动上传',
            originalPrompt: fileName || '手动上传',
            model: 'uploaded',
            source: 'imagehost',
        }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`gallery/save 返回 ${res.status}: ${err}`);
    }
}

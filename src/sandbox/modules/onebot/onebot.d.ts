/**
 * onebot.d.ts — QQ / OneBot 平台 API
 *
 * 系统注入的 OneBot host proxy 接口。
 * 也会以 `qq` 别名暴露给 sandbox。
 */

interface OneBotMessageAck {
    message_id?: unknown;
    id?: unknown;
    chatId?: string | number;
    group_id?: string | number;
    user_id?: string | number;
}

interface OneBotMediaPayload {
    type?: string;
    file?: string;
    url?: string;
    caption?: string;
    fileName?: string;
}

declare const onebot: {
    /**
     * 发送文本消息。
     * @example
     * await onebot.sendText(chatId, "你好");
     */
    sendText(chatId: string | number, text: string, opts?: { replyTo?: string | number }): Promise<OneBotMessageAck | null>;

    /**
        * 发送媒体消息。支持本地文件路径或 URL。
        * 当 `type` 为 `audio` / `voice` 时，QQ/NapCat 不支持 `replyTo`，该参数会被忽略。
     * @example
     * await onebot.sendMedia(chatId, { type: "image", file: "Downloads/a.png", caption: "图" });
     */
    sendMedia(chatId: string | number, media: string | OneBotMediaPayload, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送文件。
     * @example
     * await onebot.sendFile(chatId, "Downloads/report.pdf", { caption: "日报" });
     */
    sendFile(chatId: string | number, filePath: string, opts?: { replyTo?: string | number; caption?: string; fileName?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送贴纸或图片表情。
     * @example
     * await onebot.sendSticker(chatId, "Downloads/sticker.png");
     */
    sendSticker(chatId: string | number, sticker: string | Record<string, unknown>, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送 QQ 系统表情（CQ face）。
     * @example
     * await onebot.sendFace(chatId, 21);
     */
    sendFace(chatId: string | number, faceId: string | number, opts?: { replyTo?: string | number; text?: string }): Promise<OneBotMessageAck | null>;

    /**
     * OneBot 无 typing 指示，此方法为 no-op。
     */
    sendTyping(chatId: string | number): Promise<void>;

    /**
     * 撤回消息。
     * @example
     * await onebot.deleteMessages(chatId, [messageId]);
     */
    deleteMessages(chatId: string | number, messageIds: Array<string | number>): Promise<void>;

    /**
     * 下载 QQ 媒体到 CyberGroupmate 本机 workspace/Downloads/。
     * mediaRef 可以是图片/媒体 file、URL、base64/data URL，也可以直接传 OneBot 消息 ID；
     * 传消息 ID 时会通过 NapCat get_msg 解析消息里的图片/媒体段。
     * @example
     * const localPath = await onebot.downloadMedia(794582600);
     */
    downloadMedia(mediaRef: string | number): Promise<string>;
};

declare const qq: typeof onebot;

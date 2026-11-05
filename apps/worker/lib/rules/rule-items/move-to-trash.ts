import {getRedis} from "../../../lib/get-redis";

export const moveToTrash = async (
    threadId: string,
    mailboxId: string,
    moveImap: boolean,
    messageId?: string,
    // true = only `messageId` goes (sender blocking), not the whole thread.
    messageGrain = false,
) => {
    const ids = [threadId]

    if (!ids.length || !mailboxId) return;

    const { smtpQueue, searchIngestQueue } = await getRedis();

    await Promise.all(
        ids.map((threadId) =>
            smtpQueue.add(
                "mail:move",
                {
                    threadId, mailboxId, op: "trash", messageId, moveImap,
                    ...(messageGrain && messageId ? { messageIds: [messageId] } : {}),
                },
                {
                    attempts: 3,
                    backoff: { type: "exponential", delay: 1500 },
                    removeOnComplete: true,
                    removeOnFail: false,
                },
            ),
        ),
    );

    await Promise.all(
        ids.map((threadId) =>
            searchIngestQueue.add(
                "refresh-thread",
                { threadId },
                {
                    jobId: `refresh-${threadId}`,
                    removeOnComplete: true,
                    removeOnFail: false,
                    attempts: 3,
                    backoff: { type: "exponential", delay: 1500 },
                },
            ),
        ),
    );
};

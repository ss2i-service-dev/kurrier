import {
	fetchIdentityMailboxList,
	fetchMailbox,
	fetchMailboxThreads,
} from "@/lib/actions/mailbox";
import {fetchLabelsByIdentityPublicId, fetchMailboxThreadLabels} from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import MailPagination from "@/components/mailbox/default/mail-pagination";
import WebmailList from "@/components/mailbox/default/webmail-list";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import { isModernUi } from "@/lib/actions/interface-pref";
import ListSlot from "@/components/mailbox/default/list-slot";
import { listUnderThread } from "@/lib/actions/list-under-thread";
import KThreadList from "@/components/k/thread-list";
import { fetchKPinnedThreads } from "@/lib/actions/k-pins";
import { kRealAttachmentsOf } from "@/lib/actions/k-threads";

async function ClassicPage({
	params,
	searchParams,
}: {
	params: { identityPublicId: string; mailboxSlug?: string };
	searchParams: { page?: string };
}) {
	const { page } = await searchParams;
	const { identityPublicId, mailboxSlug } = await params;
	const publicConfig = getPublicEnv();
	const mailboxThreadPromise = fetchMailboxThreads(
		identityPublicId,
		String(mailboxSlug),
		Number(page),
	).then(async (mailboxThreads) => {
		const labelsByThreadId = await fetchMailboxThreadLabels(mailboxThreads);
		return { mailboxThreads, labelsByThreadId };
	});


	const identityMailboxesPromise = fetchIdentityMailboxList();
	const globalLabelsPromise = fetchLabelsByIdentityPublicId({
		identityPublicId,
		scope: "thread",
	});

	const fetchMailboxPromise = fetchMailbox(
		identityPublicId,
		mailboxSlug,
	)
	const workspacePublicId = await getWorkspacePublicId()
	// Folder list hidden under an open thread (per-user option).
	const listMode = await listUnderThread();
	return (
		<ListSlot mode={listMode}>
			<div className="flex flex-1 flex-col gap-4 p-4 mb-12">
				<WebmailList
					mailboxThreadPromise={mailboxThreadPromise}
					publicConfig={publicConfig}
					identityPublicId={identityPublicId}
					fetchMailboxPromise={fetchMailboxPromise}
					identityMailboxesPromise={identityMailboxesPromise}
					globalLabelsPromise={globalLabelsPromise}
					workspacePublicId={workspacePublicId}
				/>

				<MailPagination
					key={page}
					workspacePublicId={workspacePublicId}
					fetchMailboxPromise={fetchMailboxPromise}
					identityPublicId={identityPublicId}
					page={Number(page)}
				/>
			</div>
		</ListSlot>
	);
}

// Modern interface (per-user option): same data, different presentation.
async function ModernPage({
	params,
	searchParams,
}: {
	params: { identityPublicId: string; mailboxSlug?: string };
	searchParams: { page?: string };
}) {
	const { page } = await searchParams;
	const { identityPublicId, mailboxSlug } = await params;
	const publicConfig = getPublicEnv();
	const mailboxThreadPromise = fetchMailboxThreads(identityPublicId, String(mailboxSlug), Number(page)).then(
		async (mailboxThreads) => {
			const [labelsByThreadId, realAttachments] = await Promise.all([
				fetchMailboxThreadLabels(mailboxThreads),
				kRealAttachmentsOf(mailboxThreads),
			]);
			return { mailboxThreads, labelsByThreadId, realAttachments };
		},
	);
	const fetchMailboxPromise = fetchMailbox(identityPublicId, mailboxSlug);
	const workspacePublicId = await getWorkspacePublicId();
	return (
		<div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
			<KThreadList
				mailboxThreadPromise={mailboxThreadPromise}
				pinnedPromise={fetchKPinnedThreads(identityPublicId, String(mailboxSlug))}
				publicConfig={publicConfig}
				identityPublicId={identityPublicId}
				fetchMailboxPromise={fetchMailboxPromise}
				identityMailboxesPromise={fetchIdentityMailboxList()}
				globalLabelsPromise={fetchLabelsByIdentityPublicId({ identityPublicId, scope: "thread" })}
				workspacePublicId={workspacePublicId}
				startPage={Number(page) > 0 ? Number(page) : 1}
			/>
		</div>
	);
}

async function Page(props: {
	params: { identityPublicId: string; mailboxSlug?: string };
	searchParams: { page?: string };
}) {
	return (await isModernUi()) ? <ModernPage {...props} /> : <ClassicPage {...props} />;
}

export default Page;

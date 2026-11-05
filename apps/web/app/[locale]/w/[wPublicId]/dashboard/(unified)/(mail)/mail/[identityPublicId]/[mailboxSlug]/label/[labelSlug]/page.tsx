import { fetchIdentityMailboxList, fetchMailbox } from "@/lib/actions/mailbox";
import {
	fetchLabelsByIdentityPublicId,
	fetchMailboxThreadLabels,
	fetchMailboxThreadsByLabel,
} from "@/lib/actions/labels";
import { getPublicEnv } from "@schema";
import LabelPagination from "@/components/dashboard/labels/label-pagination";
import { IconLabelFilled } from "@tabler/icons-react";
import { PAGE_SIZE } from "@common/mail-client";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import { isModernUi } from "@/lib/actions/interface-pref";
import { KPager } from "@/components/k/section";

async function ClassicLabelPage({
	params,
	searchParams,
}: {
	params: { mailboxSlug: string; identityPublicId: string; labelSlug: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	const { identityPublicId, mailboxSlug, labelSlug } = await params;
	const resolvedSearchParams = await searchParams;
	const publicConfig = await getPublicEnv();
	const page = Math.max(
		1,
		Number((resolvedSearchParams.page as string | undefined) ?? 1),
	);
	const { activeMailbox, mailboxSync } = await fetchMailbox(
		identityPublicId,
		mailboxSlug,
	);

	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabelsByIdentityPublicId({
		identityPublicId,
		scope: "thread",
	});

	const { threads: mailboxThreads, total } = await fetchMailboxThreadsByLabel(
		identityPublicId,
		mailboxSlug,
		labelSlug,
		page
	);

	const labelsByThreadId = await fetchMailboxThreadLabels(mailboxThreads);
	const label = globalLabels.find((l) => l.slug === labelSlug);
	const workspacePublicId = await getWorkspacePublicId()

	return (
		<div className="flex flex-1 flex-col gap-4 p-4 mb-12">
			<header className="flex items-center justify-between">
				<div className="text-sm text-muted-foreground flex items-center gap-2">
					Label:
					<IconLabelFilled size={24} color={String(label?.colorBg)} />
					<span className="font-semibold">{label?.name ?? labelSlug}</span>
				</div>

				{total > 0 && (
					<div className="text-xs text-muted-foreground">
						<span className="font-medium">{(page - 1) * PAGE_SIZE + 1}</span>–
						<span className="font-medium">
							{Math.min(page * PAGE_SIZE, total)}
						</span>{" "}
						of <span className="font-semibold">{total}</span>
					</div>
				)}
			</header>

			<WebmailListLabelSearch
				mailboxThreads={mailboxThreads}
				publicConfig={publicConfig}
				activeMailbox={activeMailbox}
				workspacePublicId={workspacePublicId}
				identityPublicId={identityPublicId}
				mailboxSync={mailboxSync ?? undefined}
				identityMailboxes={identityMailboxes}
				globalLabels={globalLabels}
				labelsByThreadId={labelsByThreadId}
			/>

			<LabelPagination
				key={page}
				workspacePublicId={workspacePublicId}
				total={total}
				pageSize={PAGE_SIZE}
				page={page}
				identityPublicId={identityPublicId}
				mailboxSlug={mailboxSlug}
				labelSlug={labelSlug}
			/>
		</div>
	);
}

// Modern interface (per-user option): same data, different presentation.
async function ModernLabelPage({
	params,
	searchParams,
}: {
	params: { mailboxSlug: string; identityPublicId: string; labelSlug: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	const { identityPublicId, mailboxSlug, labelSlug } = await params;
	const resolvedSearchParams = await searchParams;
	const publicConfig = await getPublicEnv();
	const page = Math.max(1, Number((resolvedSearchParams.page as string | undefined) ?? 1));
	const { activeMailbox, mailboxSync } = await fetchMailbox(identityPublicId, mailboxSlug);
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabelsByIdentityPublicId({ identityPublicId, scope: "thread" });
	const { threads: mailboxThreads, total } = await fetchMailboxThreadsByLabel(identityPublicId, mailboxSlug, labelSlug, page);
	const labelsByThreadId = await fetchMailboxThreadLabels(mailboxThreads);
	const label = globalLabels.find((l) => l.slug === labelSlug);
	const workspacePublicId = await getWorkspacePublicId();
	const name = label?.name ?? labelSlug;

	return (
		<div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
			<WebmailListLabelSearch
				mailboxThreads={mailboxThreads}
				publicConfig={publicConfig}
				activeMailbox={activeMailbox}
				workspacePublicId={workspacePublicId}
				identityPublicId={identityPublicId}
				mailboxSync={mailboxSync ?? undefined}
				identityMailboxes={identityMailboxes}
				globalLabels={globalLabels}
				labelsByThreadId={labelsByThreadId}
				kTitle={
					<span className="inline-flex items-center gap-2">
						<IconLabelFilled size={18} color={String(label?.colorBg)} />
						{name}
					</span>
				}
				kEmptyTitle="No messages with this label"
				kEmptyText={`No thread in "${activeMailbox.name}" has the label "${name}".`}
			/>
			<KPager
				page={page}
				total={total}
				pageSize={PAGE_SIZE}
				href={(n) => `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}/label/${labelSlug}?page=${n}`}
			/>
		</div>
	);
}

export default async function LabelPage(props: {
	params: { mailboxSlug: string; identityPublicId: string; labelSlug: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	return (await isModernUi()) ? <ModernLabelPage {...props} /> : <ClassicLabelPage {...props} />;
}

<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';
	import AdminIcon from '#lib/components/admin/AdminIcon.svelte';
	import AdminNav from '#lib/components/admin/AdminNav.svelte';
	import ConfirmAction from '#lib/components/admin/ConfirmAction.svelte';
	import Note from '#lib/components/admin/Note.svelte';
	import Thumb from '#lib/components/admin/Thumb.svelte';
	import { formatDay } from '#lib/client/format';

	let { data, form }: PageProps = $props();

	const result = (section: string) => (form?.section === section ? form : null);
	const day = (ms: number) => formatDay(ms, data.timeZone);
	const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	const EMAIL_STATUS: Record<string, string> = {
		pending: 'Email on its way',
		sent: 'Emailed to you',
		saved: 'Email saved to the outbox',
		failed: "Email didn't send"
	};

	/** Forms being sent right now, by key: their buttons are disabled, so a double tap does it once. */
	let busy = $state<Record<string, boolean>>({});
	const submitting =
		(key: string, opts: { reset?: boolean } = {}): SubmitFunction =>
		() => {
			busy[key] = true;
			return async ({ update }) => {
				try {
					await update(opts);
				} finally {
					busy[key] = false;
				}
			};
		};
</script>

<svelte:head>
	<title>Admin · {data.siteTitle}</title>
</svelte:head>

<div class="page">
	<AdminNav />
	<h1>Admin</h1>

	{#each data.warnings as warning, i (i)}
		<p class="notice">{warning}</p>
	{/each}
	{#if data.email.problem}
		<p class="notice warn"><AdminIcon name="mail" /> {data.email.problem} <a class="tap" href="#email">Email</a></p>
	{/if}
	{#if data.selfCheck && !data.selfCheck.ok}
		<p class="notice warn">
			Some photos or videos can't be added until the media tools are fixed. <a class="tap" href="#tools">See what's missing</a>
		</p>
	{/if}
	{#if data.backup.error}
		<p class="notice warn">
			The copy of the database in .backups didn't work{data.backup.errorAt ? ` (${day(data.backup.errorAt)})` : ''}: {data.backup.error}
			<a class="tap" href="#storage">Storage</a>
		</p>
	{/if}

	<section class="section" id="requests" aria-labelledby="requests-title">
		<h2 id="requests-title"><Icon name="flag" /> Removal requests</h2>
		{#if data.requests.length === 0}
			<p class="empty">Nobody has asked for anything to be removed.</p>
		{:else}
			<ul class="rows">
				{#each data.requests as r (r.id)}
					<li class="row card">
						<Thumb src={r.thumbUrl} kind={r.kind} alt="The {r.kind ?? 'photo'} {r.requester} asked about" />
						<div class="text">
							<p class="lead"><strong>{r.requester}</strong> asked to remove a {r.kind ?? 'photo'} from “{r.album}”</p>
							<p>Why: {r.reason}</p>
							{#if r.details}<p class="quote">“{r.details}”</p>{/if}
							<p class="muted small">Asked {day(r.createdAt)} · {EMAIL_STATUS[r.emailStatus]}</p>
						</div>
						<a class="btn btn-primary" href="/admin/requests/{r.id}">
							Review <span class="visually-hidden">the request from {r.requester}</span><Icon name="chevron-right" />
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="section" id="problems" aria-labelledby="problems-title">
		<h2 id="problems-title"><Icon name="retry" /> Uploads that didn't work</h2>
		<Note result={result('failed')} />
		{#if data.failed.length === 0}
			<p class="empty">Everything that was added worked.</p>
		{:else}
			<ul class="rows">
				{#each data.failed as f (f.id)}
					<li class="row card">
						<Thumb src={f.thumbUrl} kind={f.kind} alt={f.name} />
						<div class="text">
							<p class="lead"><strong>{f.name}</strong></p>
							<p>Added by {f.by}{f.album ? ` to “${f.album}”` : ''} · {day(f.failedAt)}</p>
							<p>{f.problem}.</p>
							{#if f.detail}
								<details class="detail">
									<summary>Details for you</summary>
									<pre>{f.code}: {f.detail}</pre>
								</details>
							{/if}
							<div class="actions">
								{#if f.hasSource}
									<form method="POST" action="?/retry" use:enhance={submitting(f.id)}>
										<input type="hidden" name="id" value={f.id} />
										<button type="submit" class="btn" disabled={busy[f.id]}>
											<Icon name="retry" /> Try again<span class="visually-hidden">: {f.name}</span>
										</button>
									</form>
									<a class="btn" href="/admin/original/{f.id}" download>
										<Icon name="save" /> Download original<span class="visually-hidden">: {f.name}</span>
									</a>
								{/if}
								<form method="POST" action="?/trashFailed" use:enhance={submitting(f.id)}>
									<input type="hidden" name="id" value={f.id} />
									<button type="submit" class="btn btn-danger" disabled={busy[f.id]}>
										<Icon name="trash" /> Move to trash<span class="visually-hidden">: {f.name}</span>
									</button>
								</form>
							</div>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="section" id="email" aria-labelledby="email-title">
		<h2 id="email-title"><AdminIcon name="mail" /> Email</h2>
		{#if !data.email.to}
			<p>Nobody gets emails: no admin email address is set (ADMIN_EMAIL).</p>
		{:else if data.email.smtp}
			<p>Removal requests and problems are emailed to <strong>{data.email.to}</strong>.</p>
		{:else}
			<p>
				Emails for <strong>{data.email.to}</strong> are saved as files instead of being sent, because no email server is set
				up. Set SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM in the Unraid template to get them by email.
			</p>
		{/if}
		<Note result={result('email')} />
		{#if data.email.to}
			<form method="POST" action="?/testEmail" use:enhance={submitting('testEmail')}>
				<button type="submit" class="btn" disabled={busy.testEmail}><AdminIcon name="mail" /> Send test email</button>
			</form>
		{/if}
		{#if data.email.failedRequests.length > 0}
			<h3>Request emails that didn't send</h3>
			<ul class="plain">
				{#each data.email.failedRequests as e (e.id)}
					<li class="failed-email">
						<span>From {e.requester}{e.error ? `: ${e.error}` : ''}</span>
						<form method="POST" action="?/resendEmail" use:enhance={submitting(`resend-${e.id}`)}>
							<input type="hidden" name="id" value={e.id} />
							<button type="submit" class="btn" disabled={busy[`resend-${e.id}`]}>
								<AdminIcon name="mail" /> Resend<span class="visually-hidden"> the email about {e.requester}'s request</span>
							</button>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="section" id="tools" aria-labelledby="tools-title">
		<h2 id="tools-title"><Icon name="computer" /> Media tools</h2>
		{#if !data.selfCheck}
			<p>Not checked yet. That happens when the app starts.</p>
		{:else}
			{#if data.selfCheck.ok}
				<p>Everything needed to get photos and videos ready is in place.</p>
			{:else}
				<ul class="problems">
					{#each data.selfCheck.problems as p, i (i)}
						<li>{p}</li>
					{/each}
				</ul>
			{/if}
			<details class="detail">
				<summary>Versions (checked {day(data.selfCheck.checkedAt)})</summary>
				<dl class="facts">
					{#each Object.entries(data.selfCheck.tools) as [tool, version] (tool)}
						<dt>{tool}</dt>
						<dd>{version}</dd>
					{/each}
				</dl>
			</details>
		{/if}
		<Note result={result('tools')} />
		<form method="POST" action="?/checkTools" use:enhance={submitting('tools')}>
			<button type="submit" class="btn" disabled={busy.tools}><Icon name="retry" /> {busy.tools ? 'Checking…' : 'Check again'}</button>
		</form>
	</section>

	<section class="section" id="storage" aria-labelledby="storage-title">
		<h2 id="storage-title"><Icon name="album" /> Storage</h2>
		<dl class="facts">
			<dt>Photos and videos</dt>
			<dd>{plural(data.storage.photos, 'photo', 'photos')} · {plural(data.storage.videos, 'video', 'videos')} · {data.storage.library}</dd>
			<dt>Archived originals</dt>
			<dd>{data.storage.originals} ({plural(data.storage.originalsCount, 'item', 'items')})</dd>
			<dt>In the trash</dt>
			<dd><a class="tap" href="/admin/trash">{plural(data.storage.trash, 'item', 'items')}</a></dd>
			<dt>Database copy</dt>
			<dd>
				{data.backup.lastOkAt ? `Last made ${day(data.backup.lastOkAt)}` : 'None made yet'}, in .backups on the photos share (a
				minute after each start, then every day; the last 7 days are kept)
			</dd>
		</dl>
		{#if data.storage.stuckFiles > 0}
			<p class="notice warn">
				The files of {plural(data.storage.stuckFiles, 'item', 'items')} deleted for good could not be deleted yet. They are tried again
				every day.{data.storage.stuckFilesError ? ` The last problem: ${data.storage.stuckFilesError}` : ''}
			</p>
		{/if}
		{#if !data.storage.keepOriginals}
			<p class="muted">New originals are not kept (KEEP_ORIGINALS is off).</p>
		{/if}
		<Note result={result('storage')} />
		{#if data.storage.deletableOriginals > 0}
			<ConfirmAction label="Delete all archived originals…" confirmLabel="Yes, delete them" action="?/deleteOriginals">
				{#snippet icon()}<Icon name="trash" />{/snippet}
				<p>
					Archived originals are the files exactly as the phones sent them, kept only for you. Deleting them frees
					{data.storage.deletableBytes}. Everyone still sees and saves every photo and video as they are now, but they can't be
					redone later with better settings.
				</p>
				<p>Uploads that didn't work keep theirs, so they can be tried again.</p>
			</ConfirmAction>
		{/if}
		{#if data.storage.redoing > 0}
			<p>
				{plural(data.storage.redoing, 'item is', 'items are')} being redone, after any new uploads. Everyone keeps seeing the current
				version until the new one is ready.
			</p>
		{/if}
		{#if data.storage.outdated > 0}
			<p>{plural(data.storage.outdated, 'item was', 'items were')} made by an older version of this app and can be redone from the originals.</p>
			<form method="POST" action="?/reprocessOutdated" use:enhance={submitting('reprocess')}>
				<button type="submit" class="btn" disabled={busy.reprocess}><Icon name="retry" /> Redo them</button>
			</form>
		{/if}
		{#if data.storage.redoProblems > 0}
			<details>
				<summary>
					{plural(data.storage.redoProblems, "item couldn't", "items couldn't")} be redone. They still show as before.
				</summary>
				<ul class="small">
					{#each data.storage.redoProblemList as p (p.id)}
						<li>{p.name}{p.album ? ` (${p.album})` : ''}: <span class="muted">{p.error}</span></li>
					{/each}
				</ul>
			</details>
		{/if}
		{#if data.storage.previewsWaiting > 0}
			<p>
				The previews of {plural(data.storage.previewsWaiting, 'item are', 'items are')} being made again from the photos share, after any
				new uploads.
			</p>
		{/if}
		<p class="muted previews-note">
			Previews are kept in the app data folder. If it was lost or restored from an older backup, missing ones are made again from the
			photos share at the next start, or now:
		</p>
		<form method="POST" action="?/rebuildPreviews" use:enhance={submitting('previews')}>
			<button type="submit" class="btn" disabled={busy.previews}><Icon name="retry" /> Rebuild missing previews</button>
		</form>
	</section>

	<section class="section" id="albums" aria-labelledby="albums-title">
		<h2 id="albums-title"><Icon name="album" /> Albums</h2>
		<Note result={result('albums')} />
		<ul class="rows">
			{#each data.albums as a (a.id)}
				<li class="card album">
					<h3><a class="tap" href="/album/{a.id}">{a.title}</a></h3>
					<p class="muted small">
						{plural(a.visible, 'item', 'items')} showing{a.total > a.visible ? `, ${a.total} in all (including unfinished, failed and trashed)` : ''}
					</p>
					<div class="actions">
						<details class="rename">
							<summary class="btn"><Icon name="pencil" /> Rename<span class="visually-hidden"> {a.title}</span></summary>
							<form method="POST" action="?/renameAlbum" use:enhance={submitting(`rename-${a.id}`, { reset: false })}>
								<input type="hidden" name="id" value={a.id} />
								<div class="field">
									<label for="album-title-{a.id}">New name</label>
									<input id="album-title-{a.id}" class="input" name="title" value={a.title} maxlength="200" required />
								</div>
								<button type="submit" class="btn btn-primary" disabled={busy[`rename-${a.id}`]}><Icon name="check" /> Save name</button>
							</form>
						</details>
						{#if a.isDefault}
							<p class="muted small">New photos go here when no album is picked, so it can't be deleted.</p>
						{:else if a.total === 0}
							<ConfirmAction label="Delete album…" confirmLabel="Yes, delete it" action="?/deleteAlbum" fields={{ id: a.id }}>
								{#snippet icon()}<Icon name="trash" />{/snippet}
								<p>“{a.title}” is empty. It will disappear from everyone's album list.</p>
							</ConfirmAction>
						{:else}
							<ConfirmAction
								label="Delete album…"
								confirmLabel="Yes, move them and delete it"
								action="?/deleteAlbum"
								fields={{ id: a.id, move: 1 }}
							>
								{#snippet icon()}<Icon name="trash" />{/snippet}
								<p>
									“{a.title}” still has {plural(a.total, 'item', 'items')}. Albums are only deleted when they are empty, so
									{a.total === 1 ? 'it' : 'they'} will be moved to “{data.defaultAlbumTitle}” first. Anything already there goes to
									the trash instead.
								</p>
							</ConfirmAction>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>

	<section class="section" id="qr" aria-labelledby="qr-title">
		<h2 id="qr-title"><AdminIcon name="qr" /> QR cards</h2>
		<p>Print cards that let people in when they point their phone's camera at them: one for the whole site, and one for each album.</p>
		<a class="btn" href="/admin/qr"><AdminIcon name="print" /> Open the QR cards</a>
	</section>

	<section class="section" id="access" aria-labelledby="access-title">
		<h2 id="access-title"><AdminIcon name="key" /> Reset access</h2>
		<p>If the family code or a QR card got to someone it shouldn't have, you can lock everyone out and start again.</p>
		<Note result={result('access')} />
		{#if result('access')?.ok}
			<a class="btn" href="/admin/qr"><AdminIcon name="print" /> Print new QR cards</a>
		{/if}
		<ConfirmAction label="Reset access…" confirmLabel="Yes, reset access" action="?/resetAccess">
			{#snippet icon()}<AdminIcon name="key" />{/snippet}
			<p>
				Everyone is signed out on every phone and computer and has to type the family code again. Every printed QR card
				stops working, so you'll need to print new ones. You stay signed in.
			</p>
			<p>To change the family code itself, change FAMILY_PASSWORD in the Unraid template and restart.</p>
		</ConfirmAction>
	</section>
</div>

<style>
	h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.warn {
		border-left-color: var(--danger);
	}
	/* Links on their own get the same 56 px tap height as buttons. */
	.tap {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.rows,
	.plain {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--gap);
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 1rem;
		padding: 1rem;
	}
	.row .text {
		flex: 1 1 16rem;
		min-width: 0;
	}
	.text p {
		margin: 0 0 0.35rem;
	}
	.lead {
		font-size: var(--fs-large);
	}
	.quote {
		font-style: italic;
		white-space: pre-wrap;
	}
	.small {
		font-size: var(--fs-small);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.75rem;
		margin-top: 0.75rem;
	}
	.detail summary {
		cursor: pointer;
		min-height: var(--tap);
		display: flex;
		align-items: center;
		font-weight: 600;
		color: var(--primary);
	}
	.detail pre {
		margin: 0;
		padding: 0.75rem;
		max-height: 16rem;
		overflow: auto;
		white-space: pre-wrap;
		font-size: var(--fs-small);
		background: var(--surface-2);
		border-radius: var(--radius-small);
	}
	.facts {
		display: grid;
		/* A link value is a tap-height box (.tap): line its text up with the label. */
		align-items: baseline;
		grid-template-columns: minmax(8rem, max-content) 1fr;
		gap: 0.35rem 1rem;
		margin: 0 0 1rem;
	}
	.facts dt {
		font-weight: 700;
	}
	.previews-note {
		margin-top: 1.5rem;
	}
	.facts dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
	.problems li {
		margin-bottom: 0.5rem;
	}
	.failed-email {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 1rem;
	}
	.album {
		padding: 1rem;
	}
	.album h3 {
		margin-bottom: 0.25rem;
	}
	.rename summary {
		list-style: none;
	}
	.rename summary::-webkit-details-marker {
		display: none;
	}
	.rename form {
		margin-top: 0.75rem;
		max-width: 28rem;
	}
	section > form,
	section > .btn {
		margin-top: 0.5rem;
	}
</style>

<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';
	import AdminIcon from '#lib/components/admin/AdminIcon.svelte';
	import AdminNav from '#lib/components/admin/AdminNav.svelte';
	import Note from '#lib/components/admin/Note.svelte';
	import { formatDay, formatTaken } from '#lib/client/format';

	let { data, form }: PageProps = $props();

	const r = $derived(data.request);
	const item = $derived(data.item);
	const taken = $derived(formatTaken(item.takenAt, item.takenMs, data.timeZone));
	const outcome = $derived(
		r.status === 'dismissed'
			? 'Dismissed'
			: r.resolvedAction === 'moved'
				? 'Moved to another album'
				: 'Removed to the trash'
	);
	let busy = $state(false);

	/** Disables the buttons while a choice is being saved. */
	const submitting: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			try {
				await update();
			} finally {
				busy = false;
			}
		};
	};
</script>

<svelte:head>
	<title>Removal request · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow">
	<AdminNav />
	<h1>Removal request</h1>

	<figure class="preview card">
		{#if item.previewUrl}
			<img
				src={item.previewUrl}
				alt="The {item.kind} {r.requester} asked about"
				width={item.width ?? undefined}
				height={item.height ?? undefined}
			/>
		{:else}
			<span class="none"><Icon name={item.kind === 'video' ? 'video' : 'photo'} size="3em" /></span>
		{/if}
		<figcaption>
			<a class="tap" href="/view/{item.id}">Open the {item.kind}</a>
			{#if item.trashed}<span class="muted"> (it is in the trash)</span>{/if}
		</figcaption>
	</figure>

	<dl class="facts">
		<dt>Asked by</dt>
		<dd>{r.requester}, {formatDay(r.createdAt, data.timeZone)}</dd>
		<dt>Why</dt>
		<dd>{r.reason}</dd>
		{#if r.details}
			<dt>Their words</dt>
			<dd class="quote">“{r.details}”</dd>
		{/if}
		<dt>Album</dt>
		<dd><a class="tap" href="/album/{item.albumId}">{item.album}</a></dd>
		<dt>Added by</dt>
		<dd>{item.by}</dd>
		{#if taken}
			<dt>Taken</dt>
			<dd>{taken}</dd>
		{/if}
	</dl>

	<Note result={form} />
	{#if form?.conflictId}
		<p><a class="tap" href="/view/{form.conflictId}">See the copy that is already there</a></p>
	{/if}

	{#if r.status === 'pending'}
		<h2>What should happen?</h2>
		<div class="choices">
			<form method="POST" action="?/remove" use:enhance={submitting}>
				<button type="submit" class="btn btn-danger btn-block" disabled={busy}><Icon name="trash" /> Remove it</button>
				<p class="hint">It goes to the trash. You can bring it back for 30 days.</p>
			</form>

			{#if data.otherAlbums.length > 0}
				<form method="POST" action="?/move" class="move" use:enhance={submitting}>
					<div class="field">
						<label for="move-album">Move it to another album</label>
						<select id="move-album" class="input" name="album" required>
							{#each data.otherAlbums as a (a.id)}
								<option value={a.id}>{a.title}</option>
							{/each}
						</select>
					</div>
					<button type="submit" class="btn btn-block" disabled={busy}><AdminIcon name="move" /> Move it</button>
				</form>
			{/if}

			<form method="POST" action="?/dismiss" use:enhance={submitting}>
				<button type="submit" class="btn btn-block" disabled={busy}><Icon name="close" /> Dismiss the request</button>
				<p class="hint">Nothing changes. {r.requester} isn't told either way.</p>
			</form>
		</div>
	{:else}
		<p class="notice notice-ok">
			{outcome}{r.resolvedAt ? ` on ${formatDay(r.resolvedAt, data.timeZone)}` : ''}.
		</p>
		<a class="btn" href="/admin"><Icon name="arrow-left" /> Back to the overview</a>
	{/if}

	{#if item.hasOriginal}
		<p class="original">
			<a class="btn" href="/admin/original/{item.id}" download><Icon name="save" /> Download the original file</a>
		</p>
	{/if}
</div>

<style>
	/* Links on their own get the same 56 px tap height as buttons. */
	.tap {
		display: inline-flex;
		align-items: center;
		min-height: var(--tap);
		max-width: 100%;
		overflow-wrap: anywhere;
	}
	.preview {
		margin: 0 0 1.25rem;
		overflow: hidden;
	}
	.preview img {
		display: block;
		width: 100%;
		height: auto;
		max-height: 70vh;
		object-fit: contain;
		background: var(--tile-bg);
	}
	.none {
		display: grid;
		place-items: center;
		aspect-ratio: 4 / 3;
		background: var(--tile-bg);
		color: var(--muted);
	}
	figcaption {
		padding: 0.25rem 1rem;
	}
	.facts {
		display: grid;
		/* A link value is a tap-height box (.tap): line its text up with the label. */
		align-items: baseline;
		grid-template-columns: max-content 1fr;
		gap: 0.4rem 1rem;
		margin: 0 0 1.5rem;
	}
	.facts dt {
		font-weight: 700;
	}
	.facts dd {
		margin: 0;
	}
	.quote {
		font-style: italic;
		white-space: pre-wrap;
	}
	.choices {
		display: grid;
		gap: 1.5rem;
		margin-bottom: 1.5rem;
	}
	.choices .hint {
		margin-top: 0.4rem;
	}
	.move .field {
		margin-bottom: 0.75rem;
	}
	.original {
		margin-top: 2rem;
	}
</style>

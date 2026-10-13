<!--
	Uploader: pick photos and videos, watch them go up and get ready (docs/media-pipeline.md §6).
	One tile per file straight away; "Sending 3 of 12…" with a progress bar while sending (the
	screen is kept awake); then each tile follows the server ("Getting it ready…", "✓ Added", …).
	Copy never mentions file formats. State lives in #lib/client/uploader.svelte.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from './Icon.svelte';
	import { BASE_ACCEPT, acceptFor, isIOS } from '#lib/media/allowlist';
	import { statusLine, type StatusLine } from '#lib/client/status';
	import { NOT_MEDIA_TEXT, UploadBatch, type UploadItem } from '#lib/client/uploader.svelte';

	interface Props {
		albumId: number;
		/** Called when every file in the current batch has finished (ready, duplicate or failed). */
		ondone?: () => void;
	}

	let { albumId, ondone }: Props = $props();

	const batch = new UploadBatch({ albumId: () => albumId, ondone: () => ondone?.() });
	const adminName = $derived(typeof page.data.adminName === 'string' ? page.data.adminName : 'the site admin');

	let input = $state<HTMLInputElement>();
	/** Wildcards until we know the browser (the picker only opens after hydration anyway). */
	let accept = $state(BASE_ACCEPT);
	let ios = false;

	onMount(() => {
		accept = acceptFor(navigator.userAgent);
		ios = isIOS(navigator.userAgent, navigator.maxTouchPoints);
		return () => batch.destroy();
	});

	beforeNavigate((nav) => {
		if (!batch.sending) return;
		// Leaving the site or reloading: the browser asks with its own dialog.
		if (nav.willUnload) nav.cancel();
		else if (!confirm("Your photos and videos are still being sent. If you leave this page now, the rest won't be sent. Leave anyway?")) {
			nav.cancel();
		}
	});

	function choose() {
		batch.picking();
		input?.click();
	}

	function picked() {
		const files = input?.files ? [...input.files] : [];
		// Clear the input so picking the same file again still fires `change`.
		if (input) input.value = '';
		if (files.length === 0) batch.pickerClosed();
		else batch.add(files);
	}

	type Tone = StatusLine['tone'] | 'waiting';

	function tileLine(item: UploadItem): { text: string; detail?: string; tone: Tone } {
		switch (item.stage) {
			case 'waiting':
				return { text: 'Waiting to send…', tone: 'waiting' };
			case 'sending':
				return { text: `Sending… ${item.file.size > 0 ? Math.floor((100 * item.sent) / item.file.size) : 0}%`, tone: 'busy' };
			case 'skipped':
				return { text: item.problem ?? NOT_MEDIA_TEXT, tone: 'error' };
			case 'error':
				return { text: item.problem ?? '', tone: 'retry' };
			case 'sent': {
				if (!item.mediaId) return { text: '✓ Sent', tone: 'ok' };
				const s = item.server;
				return statusLine(
					{
						status: s?.status ?? 'received',
						kind: s?.kind ?? (item.video ? 'video' : 'photo'),
						pct: s?.pct,
						etaS: s?.etaS,
						queuePos: s?.queuePos,
						errorCode: s?.errorCode
					},
					adminName
				);
			}
		}
	}

	const finishedText = $derived.by(() => {
		if (!batch.allSettled) return "Everything is sent. You can leave this page — we'll finish getting them ready.";
		let added = 0;
		let already = 0;
		let failed = 0;
		for (const i of batch.items) {
			if (i.stage === 'error' || i.server?.status === 'failed') failed++;
			else if (i.server?.status === 'ready') added++;
			else if (i.server?.status === 'duplicate') already++;
		}
		const parts = [
			...(added ? [`${added} added`] : []),
			...(already ? [`${already} already in this album`] : []),
			...(failed ? [`${failed} didn't work`] : [])
		];
		return parts.length > 0 ? `${parts.join(' · ')}.` : 'All sent.';
	});

	const announcement = $derived(
		batch.sending
			? `Sending ${batch.current} of ${batch.toSend.length}.`
			: batch.toSend.length > 0
				? `Done! ${finishedText}`
				: ''
	);
</script>

<svelte:window onfocus={() => batch.focused(ios)} />
<svelte:document onvisibilitychange={() => document.visibilityState === 'visible' && batch.visible()} />

<div class="uploader">
	<input
		bind:this={input}
		class="visually-hidden"
		type="file"
		multiple
		{accept}
		tabindex="-1"
		aria-hidden="true"
		onchange={picked}
		oncancel={() => batch.pickerClosed()}
	/>
	<button type="button" class="btn btn-primary btn-big btn-block" onclick={choose}>
		<Icon name="plus" />
		{batch.items.length > 0 ? 'Add more photos & videos' : 'Choose photos & videos'}
	</button>

	{#if batch.gap}
		<p class="notice gap" role="status">
			<span class="spinner" aria-hidden="true"></span> Getting your photos from your phone…
		</p>
	{/if}

	<!-- One polite announcement for the whole batch (the tiles themselves stay quiet). -->
	<p class="visually-hidden" role="status">{announcement}</p>

	{#if batch.items.length > 0}
		{#if batch.sending}
			<div>
				<p class="headline">Sending {batch.current} of {batch.toSend.length}…</p>
				<progress class="bar" max={batch.bytesTotal || 1} value={batch.bytesSent} aria-label="Sent so far"></progress>
				<p class="keep"><Icon name="phone" /> Keep this screen open until it says Done.</p>
			</div>
		{:else if batch.toSend.length > 0}
			<div>
				<p class="headline ok"><Icon name="check" /> Done!</p>
				<p class="keep">{finishedText}</p>
			</div>
		{/if}

		<ul class="tiles" aria-label="Your photos and videos">
			{#each batch.items as item (item.key)}
				{@const line = tileLine(item)}
				{@const picture = item.server?.posterUrl ?? item.preview}
				<li class="tile card">
					<span class="thumb">
						{#if picture}
							<img src={picture} alt="" width="96" height="96" />
						{:else}
							<Icon name={item.video ? 'video' : 'photo'} size="2em" />
						{/if}
					</span>
					<span class="body">
						<span class="name">{item.name}</span>
						<span class="line {line.tone}">
							{#if line.tone === 'busy'}<span class="spinner" aria-hidden="true"></span>{/if}
							{line.text}
						</span>
						{#if line.detail}<span class="detail">{line.detail}</span>{/if}
						{#if item.stage === 'sending'}
							<progress class="bar" max={item.file.size || 1} value={item.sent} aria-label="Sending {item.name}"></progress>
						{/if}
						{#if item.canRetry}
							<button type="button" class="btn retry" disabled={item.retrying} onclick={() => batch.retry(item)}>
								<Icon name="retry" /> Try again<span class="visually-hidden">: {item.name}</span>
							</button>
						{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<style>
	.uploader {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.gap {
		margin: 0;
	}
	.headline {
		margin: 0 0 0.5rem;
		font-size: var(--fs-large);
		font-weight: 700;
	}
	.headline.ok {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		color: var(--ok);
	}
	.keep {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0.5rem 0 0;
		color: var(--muted);
	}
	.bar {
		display: block;
		width: 100%;
		height: 0.9rem;
		accent-color: var(--primary);
	}
	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
		gap: 0.75rem;
	}
	.tile {
		display: flex;
		gap: 0.9rem;
		padding: 0.75rem;
		align-items: flex-start;
	}
	.thumb {
		flex: none;
		display: grid;
		place-items: center;
		width: 4.5rem;
		height: 4.5rem;
		border-radius: var(--radius-small);
		background: var(--tile-bg);
		color: var(--muted);
		overflow: hidden;
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		min-width: 0;
		flex: 1;
	}
	.name {
		font-size: var(--fs-small);
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.line {
		font-weight: 700;
	}
	.line.ok {
		color: var(--ok);
	}
	.line.error,
	.line.retry {
		color: var(--danger);
	}
	.line.waiting {
		color: var(--muted);
		font-weight: 600;
	}
	.detail {
		font-size: var(--fs-small);
		color: var(--muted);
	}
	.spinner {
		margin-right: 0.35rem;
	}
	.retry {
		align-self: flex-start;
	}
</style>

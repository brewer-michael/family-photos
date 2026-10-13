<!--
	One photo or video, big. Previous/Next buttons (swipe and ← → keys are extras), the bottom
	action bar with "Save to my phone", and the Save sheet that long-press / right-click opens so
	people always save the full-quality file, never the preview. Mount it per item ({#key}).
-->
<script lang="ts">
	import { onMount, untrack, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import SaveButton from './SaveButton.svelte';
	import type { SaveTargetDTO, ViewItemDTO } from '#lib/client/dto';
	import { formatTaken, tileAlt } from '#lib/client/format';
	import { longPress, swipe } from '#lib/client/gestures';
	import { Saver } from '#lib/client/saver.svelte';

	interface Props {
		item: ViewItemDTO;
		save: SaveTargetDTO;
		prevHref: string | null;
		nextHref: string | null;
		timeZone: string;
		/** More buttons for the bottom bar, after "Save to my phone". */
		actions?: Snippet;
	}

	let { item, save, prevHref, nextHref, timeZone, actions }: Props = $props();

	// One Saver per mounted item (the parent remounts this component for each item).
	const saver = new Saver(untrack(() => save));
	let sheet = $state<HTMLDialogElement>();
	const kindWord = $derived(item.kind === 'video' ? 'video' : 'photo');
	const taken = $derived(formatTaken(item.takenAt, item.takenMs, timeZone));

	onMount(() => {
		saver.start(true);
		return () => saver.dispose();
	});

	function openSheet() {
		if (sheet && !sheet.open) sheet.showModal();
	}
	function closeSheet() {
		sheet?.close();
	}

	function go(href: string | null) {
		if (href) void goto(href, { replaceState: true });
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || sheet?.open) return;
		const el = e.target as HTMLElement | null;
		if (el?.closest('input, textarea, select, video, dialog, [contenteditable="true"]')) return;
		if (e.key === 'ArrowLeft' && prevHref) go(prevHref);
		else if (e.key === 'ArrowRight' && nextHref) go(nextHref);
		else return;
		e.preventDefault();
	}
</script>

<svelte:window {onkeydown} />

<figure class="stage" use:swipe={{ onprev: () => go(prevHref), onnext: () => go(nextHref) }}>
	{#if item.kind === 'video'}
		<!-- Family videos come without captions. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			class="media"
			src={item.src}
			poster={item.placeholderUrl}
			controls
			playsinline
			preload="metadata"
			width={item.width}
			height={item.height}
			aria-label={tileAlt(item, timeZone)}
			use:longPress={{ onpress: openSheet, touch: false }}
		></video>
	{:else}
		<img
			class="media"
			src={item.src}
			alt={tileAlt(item, timeZone)}
			width={item.width}
			height={item.height}
			draggable="false"
			style:background-image="url({item.placeholderUrl})"
			use:longPress={{ onpress: openSheet }}
		/>
	{/if}
	<figcaption>
		Added by <strong>{item.by}</strong>{#if taken}<span class="sep" aria-hidden="true">·</span><span
				class="visually-hidden">, taken on</span> {taken}{/if}
	</figcaption>
</figure>

<nav class="prevnext" aria-label="Other photos in this album">
	{#if prevHref}
		<a class="btn prev" href={prevHref} data-sveltekit-replacestate>
			<Icon name="arrow-left" /> Previous
		</a>
	{/if}
	{#if nextHref}
		<a class="btn next" href={nextHref} data-sveltekit-replacestate>
			Next <Icon name="arrow-right" />
		</a>
	{/if}
</nav>

<div class="bar" role="group" aria-label="What would you like to do?">
	<SaveButton {saver} />
	{@render actions?.()}
</div>

<dialog class="sheet" bind:this={sheet} aria-labelledby="save-sheet-title">
	<h2 id="save-sheet-title">Save this {kindWord}</h2>
	<p>You'll get the full-quality {kindWord}, not the smaller preview.</p>
	<div class="sheet-actions">
		<SaveButton {saver} class="btn-big btn-block" onsaved={closeSheet} />
		<button type="button" class="btn btn-block" onclick={closeSheet}>
			<Icon name="close" /> Close
		</button>
	</div>
</dialog>

<style>
	.stage {
		margin: 0 calc(var(--gutter) * -1);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}
	.media {
		display: block;
		width: auto;
		height: auto;
		max-width: 100%;
		/* Room for the header, "Back to album", the caption, Previous/Next and the action bar. */
		max-height: max(14rem, calc(100dvh - 19.5rem));
		min-height: 8rem;
		background: var(--surface-2) center / contain no-repeat;
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}
	video.media {
		width: 100%;
		background: #000;
	}
	figcaption {
		padding: 0 var(--gutter);
		color: var(--muted);
		text-align: center;
	}
	figcaption strong {
		color: var(--text);
	}
	.sep {
		margin: 0 0.4em;
	}
	.prevnext {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		margin-top: 1rem;
	}
	.prev {
		grid-column: 1;
	}
	.next {
		grid-column: 2;
	}
	/* The thumb zone: one row of three, each an icon above its word. */
	.bar {
		position: sticky;
		bottom: 0;
		z-index: 5;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin: 1rem calc(var(--gutter) * -1) 0;
		padding: 0.5rem var(--gutter) calc(0.5rem + env(safe-area-inset-bottom));
		background: var(--bg);
		border-top: 1px solid var(--line);
	}
	.bar :global(.btn) {
		flex-direction: column;
		gap: 0.2rem;
		min-height: calc(var(--tap) + 0.5rem);
		padding: 0.4rem 0.3rem;
		font-size: var(--fs-small);
		line-height: 1.15;
	}
	@media (min-width: 40rem) {
		.bar :global(.btn) {
			flex-direction: row;
			gap: 0.5rem;
			font-size: var(--fs-base);
		}
	}
	.sheet-actions {
		display: grid;
		gap: 0.75rem;
	}
</style>

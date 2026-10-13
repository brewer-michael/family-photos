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

<!-- Stuck to the bottom of the screen, so Previous/Next are never pushed out of sight. -->
<div class="dock">
	{#if prevHref || nextHref}
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
	{/if}

	<div class="bar" role="group" aria-label="What would you like to do?">
		<SaveButton {saver} />
		{@render actions?.()}
	</div>
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
		/* Room for the header, "Back to album", the caption and the dock (Previous/Next + actions). */
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
	/*
	 * The thumb zone (docs/PLAN.md "UX rules"): Previous/Next above the actions, stuck to the bottom
	 * of the screen whatever the photo's shape, the header's height or the text size. With very
	 * large text it never takes more than half the screen (it scrolls, Previous/Next first).
	 */
	.dock {
		position: sticky;
		bottom: 0;
		z-index: 5;
		container-type: inline-size;
		display: grid;
		gap: 0.5rem;
		max-height: 50dvh;
		overflow-y: auto;
		margin: 1rem calc(var(--gutter) * -1) 0;
		padding: 0.5rem var(--gutter) calc(0.5rem + env(safe-area-inset-bottom));
		background: var(--bg);
		border-top: 1px solid var(--line);
	}
	.prevnext {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.prevnext .btn {
		min-width: 0;
		padding-inline: 0.5rem;
	}
	.prev {
		grid-column: 1;
	}
	.next {
		grid-column: 2;
	}
	/* One row of three, each an icon above its word. */
	.bar {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
	}
	/* Direct children only: the "Ask to remove" sheet is rendered in here too and keeps its own look. */
	.bar > :global(.btn) {
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
		min-height: calc(var(--tap) + 0.5rem);
		padding: 0.4rem 0.2rem;
		font-size: var(--fs-base);
		line-height: 1.15;
		/* Last resort, if a word is still wider than its third: break it rather than run into the next. */
		hyphens: auto;
		overflow-wrap: anywhere;
	}
	@media (min-width: 40rem) {
		.bar > :global(.btn) {
			flex-direction: row;
			gap: 0.5rem;
		}
	}
	/* Larger text: the arrows go above "Previous" and "Next"… */
	@container (width < 15.5rem) {
		.prevnext .btn {
			flex-direction: column;
			gap: 0.2rem;
		}
		.prevnext .next {
			flex-direction: column-reverse;
		}
	}
	/* …three actions no longer fit side by side (a word like "memory" is about 4em), so one per row… */
	@container (width < 15rem) {
		.bar {
			grid-template-columns: minmax(0, 1fr);
		}
		.bar > :global(.btn) {
			flex-direction: row;
			gap: 0.6rem;
			min-height: var(--tap);
			padding-inline: 0.75rem;
		}
	}
	/* …and with even larger text, Previous above Next. */
	@container (width < 11.5rem) {
		.prevnext {
			grid-template-columns: minmax(0, 1fr);
		}
		.prev,
		.next {
			grid-column: auto;
		}
		.prevnext .btn {
			flex-direction: row;
		}
	}
	.sheet-actions {
		display: grid;
		gap: 0.75rem;
	}
</style>

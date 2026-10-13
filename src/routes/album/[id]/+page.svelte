<script lang="ts">
	import { flushSync, tick } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageProps } from './$types';
	import AlbumForm from '#lib/components/AlbumForm.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import MediaGrid from '#lib/components/MediaGrid.svelte';
	import PendingTiles from '#lib/components/PendingTiles.svelte';
	import SaveAll from '#lib/components/SaveAll.svelte';
	import Uploader from '#lib/components/Uploader.svelte';
	import type { TileDTO } from '#lib/client/dto';
	import { countLabel } from '#lib/client/format';
	import { fetchTilesUpTo, type TilePage } from '#lib/client/tiles';

	let { data, form }: PageProps = $props();

	/**
	 * The album whose uploader has been opened on this visit. Shown by default for an empty album or
	 * ?add; once shown it stays (nothing closes it), so an upload in progress never disappears.
	 */
	let openedFor = $state<number | null>(null);
	const showUploader = $derived(openedFor === data.album.id || data.openUploader);
	let uploaderSection = $state<HTMLElement>();
	let uploader = $state<ReturnType<typeof Uploader>>();

	/**
	 * Tiles fetched by "Show more", continuing the first page that ended at `from`. Once the first
	 * page changes (new photos at the top push its end along), they no longer follow on from it.
	 */
	let more = $state<{ albumId: number; from: string; items: TileDTO[]; next: string | null } | null>(null);
	let loadingMore = $state(false);
	let moreError = $state('');
	const current = $derived(more && more.albumId === data.album.id && more.from === data.next ? more : null);
	const extra = $derived(current?.items ?? []);
	const next = $derived(current ? current.next : data.next);
	const tiles = $derived.by(() => {
		const seen = new Set(data.items.map((t) => t.id));
		return [...data.items, ...extra.filter((t) => !seen.has(t.id))];
	});

	/**
	 * "Add photos & videos": show the uploader and open the picker in the same tap. Synchronously
	 * (flushSync, no await), so the click on the file input still counts as the tap (iOS insists).
	 */
	function addPhotos() {
		flushSync(() => (openedFor = data.album.id));
		uploaderSection?.focus();
		uploader?.choose();
	}

	async function fetchTiles(before: string, limit?: number): Promise<TilePage> {
		const q = `before=${encodeURIComponent(before)}${limit ? `&limit=${limit}` : ''}`;
		const res = await fetch(`/album/${data.album.id}/items?${q}`);
		if (!res.ok) throw new Error(String(res.status));
		return (await res.json()) as { items: TileDTO[]; next: string | null };
	}

	async function showMore(e: MouseEvent) {
		const from = data.next;
		if (!next || !from) return;
		e.preventDefault();
		loadingMore = true;
		moreError = '';
		try {
			const page = await fetchTiles(next);
			more = { albumId: data.album.id, from, items: [...extra, ...page.items], next: page.next };
			await tick();
			// Keyboard and screen-reader users continue at the first new tile.
			if (page.items[0]) document.querySelector<HTMLElement>(`a[href="/view/${page.items[0].id}"]`)?.focus();
		} catch {
			moreError = "Couldn't load more. Please try again.";
		} finally {
			loadingMore = false;
		}
	}

	/**
	 * New uploads are ready: reload the first page, then the tiles "Show more" had added, as far
	 * down as before, from the first page's new end (so none fall between the two).
	 */
	async function refresh() {
		const shown = extra.length;
		// Keep the uploader (and its summary) open even when the album is no longer empty.
		if (showUploader) openedFor = data.album.id;
		await invalidateAll();
		const from = data.next;
		if (shown === 0 || !from) return;
		try {
			const page = await fetchTilesUpTo(fetchTiles, from, shown);
			more = { albumId: data.album.id, from, items: page.items, next: page.next };
		} catch {
			// The first page is fresh; "Show more" picks up from there.
		}
	}
</script>

<svelte:head>
	<title>{data.album.title} · {data.siteTitle}</title>
</svelte:head>

<div class="page">
	<a class="back" href="/"><Icon name="arrow-left" /> All albums</a>

	<header class="album-head">
		{#if data.editing}
			<h1>Change album details</h1>
			<AlbumForm
				action="?/edit"
				title={form?.values?.title ?? data.album.title}
				whenText={form?.values?.whenText ?? data.album.whenText}
				description={form?.values?.description ?? data.album.description}
				submitLabel="Save changes"
				error={form?.editError}
				cancelHref="/album/{data.album.id}"
			/>
		{:else}
			<h1>{data.album.title}</h1>
			{#if data.album.whenText}<p class="when">{data.album.whenText}</p>{/if}
			{#if data.album.description}<p class="about">{data.album.description}</p>{/if}
			<p class="muted">
				{countLabel(data.album.photoCount, data.album.videoCount)}{data.album.createdByName
					? ` · Started by ${data.album.createdByName}`
					: ''}
			</p>
			{#if data.canEdit}
				<a class="btn btn-quiet edit" href="?edit"><Icon name="pencil" /> Change name or details</a>
			{/if}
		{/if}
	</header>

	<div class="toolbar">
		<!-- One big add button at a time: this one until the uploader shows, then the uploader's own. -->
		{#if !showUploader}
			<button type="button" class="btn btn-primary btn-big" onclick={addPhotos}>
				<Icon name="plus" /> Add photos &amp; videos
			</button>
		{/if}
		<SaveAll albumId={data.album.id} itemCount={data.album.itemCount} />
	</div>

	{#if showUploader}
		<section
			id="add-section"
			class="add card"
			aria-label="Add photos and videos to {data.album.title}"
			tabindex="-1"
			bind:this={uploaderSection}
		>
			{#key data.album.id}
				<!-- Finished uploads move to the grid, or to "These didn't work" when they failed. -->
				<Uploader bind:this={uploader} albumId={data.album.id} ondone={refresh} clearOnDone />
			{/key}
		</section>
	{/if}

	{#if data.pending.length > 0}
		<!-- "Still on their way" and "These didn't work" (only their uploader and the admin see them). -->
		<PendingTiles items={data.pending} adminName={data.adminName} onsettled={refresh} />
	{/if}

	<section class="section" aria-labelledby="grid-title">
		<h2 id="grid-title" class="visually-hidden">Photos and videos</h2>
		{#if data.olderPage}
			<p><a href="/album/{data.album.id}">Back to the newest photos</a></p>
		{/if}
		{#if tiles.length > 0}
			<MediaGrid items={tiles} timeZone={data.timeZone} label="Photos and videos in {data.album.title}" />
		{:else}
			<div class="empty">
				<p>No photos here yet.</p>
				<p>Tap the big button above to put the first ones in.</p>
			</div>
		{/if}
		{#if next}
			<a
				class="btn btn-block more"
				href="?before={encodeURIComponent(next)}"
				data-sveltekit-preload-data="off"
				onclick={showMore}
				aria-busy={loadingMore}
			>
				{#if loadingMore}<span class="spinner" aria-hidden="true"></span> Loading…{:else}Show more{/if}
			</a>
		{/if}
		{#if moreError}<p class="error" role="alert">{moreError}</p>{/if}
	</section>
</div>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		font-weight: 600;
	}
	.album-head {
		margin-bottom: 1rem;
	}
	.when {
		font-size: var(--fs-large);
		color: var(--muted);
		margin-bottom: 0.5rem;
	}
	.about {
		white-space: pre-wrap;
		max-width: var(--text-max);
	}
	.edit {
		padding-inline: 0;
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem 1rem;
	}
	.toolbar > .btn {
		flex: 1 1 18rem;
		max-width: 28rem;
	}
	.add {
		margin-top: 1rem;
		padding: 1rem;
	}
	.more {
		margin-top: 1rem;
	}
</style>

<script lang="ts">
	import { tick } from 'svelte';
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

	let { data, form }: PageProps = $props();

	/** Uploader shown? null = the page's default (open for an empty album or ?add). */
	let uploaderChoice = $state<{ albumId: number; open: boolean } | null>(null);
	const showUploader = $derived(
		uploaderChoice?.albumId === data.album.id ? uploaderChoice.open : data.openUploader
	);
	/** Once shown, the uploader stays mounted (just hidden), so closing it never stops an upload. */
	const uploaderMounted = $derived(showUploader || uploaderChoice?.albumId === data.album.id);
	let uploaderSection = $state<HTMLElement>();

	/** Pages fetched by "Show more" (for this album only). */
	let more = $state<{ albumId: number; items: TileDTO[]; next: string | null } | null>(null);
	let loadingMore = $state(false);
	let moreError = $state('');
	const extra = $derived(more?.albumId === data.album.id ? more.items : []);
	const next = $derived(more?.albumId === data.album.id ? more.next : data.next);
	const tiles = $derived.by(() => {
		const seen = new Set(data.items.map((t) => t.id));
		return [...data.items, ...extra.filter((t) => !seen.has(t.id))];
	});

	async function toggleUploader() {
		uploaderChoice = { albumId: data.album.id, open: !showUploader };
		if (!showUploader) return;
		await tick();
		uploaderSection?.focus();
	}

	async function showMore(e: MouseEvent) {
		if (!next) return;
		e.preventDefault();
		loadingMore = true;
		moreError = '';
		try {
			const res = await fetch(`/album/${data.album.id}/items?before=${encodeURIComponent(next)}`);
			if (!res.ok) throw new Error(String(res.status));
			const page = (await res.json()) as { items: TileDTO[]; next: string | null };
			more = { albumId: data.album.id, items: [...extra, ...page.items], next: page.next };
			await tick();
			// Keyboard and screen-reader users continue at the first new tile.
			if (page.items[0]) document.querySelector<HTMLElement>(`a[href="/view/${page.items[0].id}"]`)?.focus();
		} catch {
			moreError = "Couldn't load more. Please try again.";
		} finally {
			loadingMore = false;
		}
	}

	function refresh() {
		void invalidateAll();
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
		<button
			type="button"
			class="btn btn-primary btn-big"
			aria-expanded={showUploader}
			aria-controls="add-section"
			onclick={toggleUploader}
		>
			<Icon name="plus" /> Add photos &amp; videos
		</button>
		<SaveAll albumId={data.album.id} itemCount={data.album.itemCount} />
	</div>

	<section
		id="add-section"
		class="add card"
		hidden={!showUploader}
		aria-label="Add photos and videos to {data.album.title}"
		tabindex="-1"
		bind:this={uploaderSection}
	>
		{#if uploaderMounted}
			{#key data.album.id}
				<Uploader albumId={data.album.id} ondone={refresh} />
			{/key}
		{/if}
	</section>

	{#if data.pending.length > 0}
		<section class="section" aria-labelledby="pending-title">
			<h2 id="pending-title">Still on their way</h2>
			<PendingTiles items={data.pending} adminName={data.adminName} onsettled={refresh} />
		</section>
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
				<p>Tap <strong>Add photos &amp; videos</strong> to put the first ones in.</p>
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
	.add[hidden] {
		display: none;
	}
	.more {
		margin-top: 1rem;
	}
</style>

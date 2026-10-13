<script lang="ts">
	import { page } from '$app/state';
	import type { PageProps } from './$types';
	import Icon from '#lib/components/Icon.svelte';
	import MemoryList from '#lib/components/MemoryList.svelte';
	import RemoveDialog from '#lib/components/RemoveDialog.svelte';
	import Viewer from '#lib/components/Viewer.svelte';

	let { data, form }: PageProps = $props();

	const kindWord = $derived(data.item.kind === 'video' ? 'video' : 'photo');

	function writeMemory(e: MouseEvent) {
		const box = document.getElementById('memory-body');
		if (!box) return;
		e.preventDefault();
		box.scrollIntoView({ block: 'center' });
		box.focus({ preventScroll: true });
	}
</script>

<svelte:head>
	<title>{kindWord === 'video' ? 'Video' : 'Photo'} in {data.album.title} · {data.siteTitle}</title>
</svelte:head>

<!-- Everything per item is remounted on prev/next, so no state (or held file) carries over. -->
{#key data.item.id}
	<div class="page view">
		<a class="back" href="/album/{data.album.id}"><Icon name="arrow-left" /> Back to album</a>
		<h1 class="visually-hidden">{kindWord === 'video' ? 'Video' : 'Photo'} in {data.album.title}</h1>

		{#if data.trashed}
			<p class="notice">This {kindWord} is in the trash. Only you, the admin, can see it.</p>
		{/if}

		<Viewer
			item={data.item}
			save={data.save}
			prevHref={data.prevHref}
			nextHref={data.nextHref}
			timeZone={data.timeZone}
		>
			{#snippet actions()}
				<a class="btn" href="#write-memory" onclick={writeMemory}><Icon name="memory" /> Write a memory</a>
				<RemoveDialog kindWord={kindWord} adminName={data.adminName} alreadyAsked={data.alreadyAsked} result={form?.remove} />
			{/snippet}
		</Viewer>

		{#if data.originalHref}
			<p class="original">
				<a class="btn" href={data.originalHref} download><Icon name="save" /> Download the original file</a>
				<span class="muted">Only you, the admin, see this. It is the {kindWord} exactly as it was sent.</span>
			</p>
		{/if}

		<MemoryList
			memories={data.memories}
			editingId={data.editingId}
			pagePath={page.url.pathname}
			{kindWord}
			timeZone={data.timeZone}
			result={form?.memory}
		/>
	</div>
{/key}

<style>
	.view {
		padding-bottom: 1rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		margin-bottom: 0.5rem;
		font-weight: 600;
	}
	.original {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		margin-top: 1.5rem;
	}
</style>

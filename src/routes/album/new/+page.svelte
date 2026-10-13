<script lang="ts">
	import type { PageProps } from './$types';
	import AlbumForm from '#lib/components/AlbumForm.svelte';
	import Icon from '#lib/components/Icon.svelte';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>New album · {data.siteTitle}</title>
</svelte:head>

<div class="page page-narrow">
	<a class="back" href="/"><Icon name="arrow-left" /> All albums</a>
	<h1>Start a new album</h1>
	<p class="muted">Give it a name. Then you can add photos and videos straight away.</p>
	<AlbumForm
		title={form?.values?.title}
		whenText={form?.values?.whenText}
		description={form?.values?.description}
		submitLabel="Create album"
		error={form?.error}
		cancelHref="/"
	/>
</div>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		min-height: var(--tap);
		font-weight: 600;
	}
</style>

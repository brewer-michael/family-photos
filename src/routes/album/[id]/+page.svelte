<script lang="ts">
	import type { PageProps } from './$types';
	import Uploader from '#lib/components/Uploader.svelte';

	let { data }: PageProps = $props();
</script>

<p><a href="/">← All albums</a></p>
<h1>{data.album.title}</h1>
{#if data.album.whenText}<p>{data.album.whenText}</p>{/if}
<p>{data.album.itemCount} {data.album.itemCount === 1 ? 'item' : 'items'}</p>

<Uploader albumId={data.album.id} />

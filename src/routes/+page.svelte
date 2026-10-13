<!-- Minimal home page; the UI track replaces it. -->
<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>{data.siteTitle}</h1>
<p>Hi {data.name}! <a href="/name">Not {data.name}?</a></p>

<h2>Albums</h2>
<ul class="albums">
	{#each data.albums as album (album.id)}
		<li>
			<a href="/album/{album.id}">{album.title}</a>
			<span>({album.itemCount} {album.itemCount === 1 ? 'item' : 'items'})</span>
		</li>
	{/each}
</ul>

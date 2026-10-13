<script lang="ts">
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<svelte:head>
	<title>{data.siteTitle}</title>
</svelte:head>

<main>
	{@render children()}
</main>

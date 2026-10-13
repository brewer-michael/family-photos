<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<h1>Admin</h1>

{#each data.warnings as warning, i (i)}
	<p role="status">{warning}</p>
{/each}

<p>Removal requests waiting: {data.pendingRequests}</p>

<form method="POST" action="/admin/logout">
	<button type="submit">Leave admin mode</button>
</form>

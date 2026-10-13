<script lang="ts">
	import { page } from '$app/state';
	import NotFound from '#lib/components/NotFound.svelte';
</script>

<NotFound status={page.status} message={page.error?.message} />

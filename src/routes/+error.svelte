<script lang="ts">
	import { page } from '$app/state';
	import NotFound from '#lib/components/NotFound.svelte';

	// For an address that matches no page Kit's message is just "Not Found"; NotFound's own
	// sentence says it better. Messages our pages give with error(404, '…') are shown as they are.
	const message = $derived(page.error?.message === 'Not Found' ? undefined : page.error?.message);
</script>

<NotFound status={page.status} {message} />

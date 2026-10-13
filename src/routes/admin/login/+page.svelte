<!-- Minimal admin sign-in; the admin track restyles it. -->
<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>Admin sign-in</h1>

<form method="POST">
	<input type="hidden" name="next" value={data.next} />
	<label for="password">Admin password</label>
	<input
		id="password"
		name="password"
		type="password"
		autocomplete="current-password"
		aria-describedby={form?.message ? 'password-error' : undefined}
	/>
	{#if form?.message}
		<p id="password-error" role="alert">{form.message}</p>
	{/if}
	<button type="submit">Sign in</button>
</form>

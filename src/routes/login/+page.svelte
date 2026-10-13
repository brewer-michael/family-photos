<!-- Minimal family-code page; the UI track restyles it. Works without JavaScript. -->
<script lang="ts">
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<h1>Welcome to {data.siteTitle}</h1>

{#if data.joinExpired}
	<p role="alert">That QR code doesn't work any more. Type the family code instead, or ask {data.adminName} for a new one.</p>
{/if}

<form method="POST">
	<input type="hidden" name="next" value={data.next} />
	<label for="code">Family code</label>
	<input
		id="code"
		name="code"
		type="text"
		autocapitalize="off"
		autocomplete="off"
		autocorrect="off"
		spellcheck="false"
		enterkeyhint="go"
		aria-describedby={form?.message ? 'code-error' : undefined}
	/>
	{#if form?.message}
		<p id="code-error" role="alert" class:limited={form.limited}>{form.message}</p>
	{/if}
	<button type="submit">Come in</button>
</form>

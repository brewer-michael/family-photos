<!--
	Icons only the admin pages use, drawn like Icon.svelte (24×24, stroke = currentColor) and always
	decorative: each one sits next to a word.
-->
<script lang="ts" module>
	const PATHS = {
		mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
		qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2M14 18h2v2M18 18h2v2h-2',
		key: 'M21 2l-9.6 9.6M15.5 7.5l3 3M18 5l3 3M7.5 22a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z',
		undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
		print: 'M7 8V3h10v5M7 17H4v-7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7h-3M7 14h10v7H7z',
		move: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 13h7M13 10l3 3-3 3'
	} as const;

	export type AdminIconName = keyof typeof PATHS;
</script>

<script lang="ts">
	interface Props {
		name: AdminIconName;
		size?: number | string;
	}

	let { name, size = '1.4em' }: Props = $props();
</script>

<svg
	aria-hidden="true"
	focusable="false"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2.2"
	stroke-linecap="round"
	stroke-linejoin="round"><path d={PATHS[name]} /></svg
>

<!--
	Inline SVG icons (24×24, stroke = currentColor). Always decorative: every icon sits next to a
	word, so it is hidden from screen readers.
-->
<script lang="ts" module>
	const STROKE = {
		home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
		plus: 'M12 5v14M5 12h14',
		'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
		'arrow-right': 'M5 12h14M13 6l6 6-6 6',
		'chevron-right': 'M9 6l6 6-6 6',
		save: 'M12 3v12M7 10l5 5 5-5M5 21h14',
		pencil: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
		trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
		flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
		close: 'M6 6l12 12M18 6 6 18',
		check: 'M5 12l5 5 9-10',
		photo: 'M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 16l5-5 4 4 3-3 6 6M17 8.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0',
		video: 'M3 7a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 10l5-3v10l-5-3',
		album: 'M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M3 9a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 17l4-4 3 3 2-2 5 5',
		memory: 'M4 5h16v11H9l-5 4zM8 9h8M8 12h5',
		retry: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
		person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
		computer: 'M3 5h18v11H3zM8 21h8M12 16v5',
		phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
		share: 'M12 3v12M8 7l4-4 4 4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8',
		shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'
	} as const;
	const FILLED = {
		play: 'M8 5v14l11-7z'
	} as const;

	export type IconName = keyof typeof STROKE | keyof typeof FILLED;
</script>

<script lang="ts">
	interface Props {
		name: IconName;
		/** Pixels; defaults to 1.4em so icons follow the text size. */
		size?: number | string;
	}

	let { name, size = '1.4em' }: Props = $props();
	const filled = $derived(name in FILLED);
	const d = $derived(filled ? FILLED[name as keyof typeof FILLED] : STROKE[name as keyof typeof STROKE]);
</script>

<svg
	aria-hidden="true"
	focusable="false"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill={filled ? 'currentColor' : 'none'}
	stroke={filled ? 'none' : 'currentColor'}
	stroke-width="2.2"
	stroke-linecap="round"
	stroke-linejoin="round"><path {d} /></svg
>

<style>
	/* Next to text that wraps (a flex row), an icon keeps its size instead of being squeezed. */
	svg {
		flex-shrink: 0;
	}
</style>

<!--
	Uploader. STUB — the uploads track replaces this with the tus-js-client uploader
	(instant tiles, previews, "Sending 3 of 12…", status polling).
	Contract: <Uploader albumId={id} ondone={() => …} />
-->
<script lang="ts">
	interface Props {
		albumId: number;
		/** Called when every file in the current batch has finished (ready, duplicate or failed). */
		ondone?: () => void;
	}

	let { albumId, ondone }: Props = $props();
</script>

<button type="button" class="uploader-button" disabled data-album-id={albumId} data-has-ondone={!!ondone}>
	Add photos &amp; videos
</button>

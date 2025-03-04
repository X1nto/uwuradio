import { HubConnection, HubConnectionBuilder } from "@microsoft/signalr";
import { currentTimestamp } from "./util";
import { play, preload, seekTo } from "./audio";
import { createSignal } from "solid-js";
import { serverUrl } from "./constants";
import { cacheImage } from "./imgCache";

const loadingSong: Song = {
	name: "loading...",
	artist: "...",
	submitter: "...",
};

export interface Song {
	name: string;
	artist: string;
	dlUrl?: string;
	artUrl?: string;
	album?: string;
	submitter: string;
}

export interface Submitter {
	name: string;
	pfpUrl: string;
	quotes: string[];
}

export default class SyncClient {
	#apiRes: (route: string) => string;

	constructor(host: string) {
		this.#apiRes = (route) => new URL(route, host).href;

		const connection = new HubConnectionBuilder()
			.withUrl(this.#apiRes("/sync"))
			.withAutomaticReconnect(new Array(10).fill(15000))
			.build();

		this.#connect(connection);
	}

	#connection: undefined | HubConnection;

	#current = createSignal<Song | undefined>(loadingSong);
	#next = createSignal<Song>();

	submitters = new Map<string, Submitter>();

	#currentStarted = createSignal<number>();
	#nextStarts = createSignal<number>();

	get currentSong() {
		return this.#current[0]();
	}
	get nextSong() {
		return this.#next[0]();
	}

	get currentStartedTime() {
		return this.#currentStarted[0]();
	}

	get nextStartsTime() {
		return this.#nextStarts[0]();
	}

	/** The seek into the current song in seconds */
	get seekPos() {
		const startTime = this.#currentStarted[0]();
		return startTime ? currentTimestamp() - startTime : undefined;
	}

	#handlers = {
		BroadcastNext: (nextSong: Song, startTime: number) => {
			this.#next[1](nextSong);
			this.#nextStarts[1](startTime);

			preload(this.#next[0]()!.dlUrl!);
			cacheImage(this.#next[0]()!.artUrl!);

			setTimeout(() => {
				this.#current[1](this.#next[0]());
				this.#currentStarted[1](this.#nextStarts[0]());
				this.#next[1]();
				this.#nextStarts[1]();

				const correction = Math.min(-(startTime - currentTimestamp()), 0);
				play(this.#current[0]()!.dlUrl!, correction);
			}, 1000 * (startTime - currentTimestamp()));
		},
		ReceiveState: (currentSong: Song, currentStarted: number, nextSong: Song, nextStart: number) => {
			this.#current[1](currentSong);
			this.#currentStarted[1](currentStarted);
			this.#next[1](nextSong);
			this.#nextStarts[1](nextStart);

			play(this.#current[0]()!.dlUrl!, this.seekPos!);
		},
		ReceiveSeekPos: (currentStarted: number) => {
			// TODO: i guess emit events, like this should only really be used if we drop connection
			//       but even shouldn't we just call ReceiveState
			this.#currentStarted[1](currentStarted);

			seekTo(this.seekPos!);
		},
	};

	async #connect(connection: HubConnection) {
		if (this.#connection) throw new Error("This client is already connected");
		this.#connection = connection;

		connection.onclose(() => (this.#connection = undefined));
		connection.onreconnected(this.updateState);

		await connection.start();

		connection.on("BroadcastNext", this.#handlers.BroadcastNext);
		connection.on("ReceiveState", this.#handlers.ReceiveState);
		connection.on("ReceiveSeekPos", this.#handlers.ReceiveSeekPos);

		this.updateState();
	}

	updateState() {
		fetch(this.#apiRes("/api/data"))
			.then((r) => r.json())
			.then((r) => {
				for (const submitter of r.submitters) this.submitters.set(submitter.name, submitter);
			});

		this.requestState();
	}

	requestState() {
		this.#connection?.invoke("RequestState");
	}

	requestSeekPos() {
		this.#connection?.invoke("RequestSeekPos");
	}
}

export const clientInstance = new SyncClient(serverUrl);

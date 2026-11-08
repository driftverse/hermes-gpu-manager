# Hermes GPU Manager

A single-GPU priority manager and streaming Ollama router for sharing a small GPU between local models (such as those used by [Hermes Agent](https://github.com/NousResearch/hermes-agent)) and occasional render jobs. Built for a Linux home server with a 4 GB NVIDIA Quadro P1000. This is an independent community project, not affiliated with or endorsed by Nous Research, and an experimental prototype rather than a turnkey installer or an audited release.

## What it does

Two Ollama instances share a model store: one GPU-capable and one CPU-only. A router chooses an instance per model. The manager plans GPU memory allocations in priority order and grants cooperative leases to external render jobs. Before freeing GPU memory it drains tracked requests; if draining cannot finish it reports the blocked transition rather than deliberately killing that request. Leases can heartbeat, expire and release. Low-priority models can remain available through the CPU backend.

This does not create extra VRAM or make generation fast. Jobs must integrate with the lease API; arbitrary GPU programs are not automatically scheduled. Multi-GPU and multi-user isolation have not been established. A process crash/restart can still interrupt requests. Backend failover only occurs before response bytes are sent.

## Safe first run: tests only

Requires Node.js >=22. No npm dependencies are declared.

```sh
npm test
```

The test fixtures use fake Ollama servers on ephemeral loopback ports, temporary state directories and an injected GPU probe. They do not render media or run inference on the physical GPU. The sanitized snapshot passed 190 tests with 0 failures on Node v26.12.1 on 2026-11-08.

For the explicitly SIMULATED GUI, after checking that port 3099 is free:

```sh
node scripts/demo.mjs
```

Open http://127.0.0.1:3099. This exercises the real manager/UI against fake backends. It is not evidence of physical GPU performance. SIGUSR1/SIGUSR2 inject/remove simulated external VRAM usage; they are not a full real-render lease integration.

## Production deployment is manual

Do not run `npm start` alongside an existing Ollama listener without planning port ownership: the default router wants 11434. Backend defaults are 11436 (GPU) and 11435 (CPU); the manager GUI/API defaults to 3017. All listeners are loopback-only. There is no automatic production installer.

The `deploy/` files are EXAMPLES. Replace `/home/example` paths and the Node/Ollama executable locations, configure model storage, and review systemd hardening before installation. The CPU service must disable both CUDA and Vulkan GPU discovery. No model weights are bundled or downloaded.

Important: `src/state.mjs` contains machine-specific workload budgets and a model tag `lfm3:1.7b-100000`. These are not portable recommendations. The LFM3 default budget of 1200 MiB is an Ollama-reported estimate, not full process memory. Historical physical measurements required about 2450 MiB at 100k context on the author's machine. Use your measured process peak plus margin; large-context split placement failed on that setup. Never assume sample defaults fit your GPU. The original deployment's actual state is deliberately not distributed.

Configuration variables: GPU_STATE_DIR, GPU_MANAGER_PORT, GPU_ROUTER_PORT, GPU_BACKEND_URL, GPU_CPU_BACKEND_URL, GPU_PUBLIC_HOST, GPU_ACCESS_ISSUER, GPU_ACCESS_AUD, GPU_OWNER_EMAIL and GPU_RECONCILE_MS. See src/config.mjs for validation/defaults. Public host values in this snapshot are placeholders.

## Security boundaries

- Manager access is direct loopback or a validated Cloudflare Access JWT for the configured owner and host. Remote lease operations are denied. Local users/processes are trusted.
- Never publicly expose the Ollama router/backends. They are not a separately authenticated multi-user API. Do not route a public tunnel to the router.
- The GUI requires matching origins for browser mutations. Static files are allowlisted and API request bodies are bounded.
- The system command runner only permits fixed GPU queries and allowlisted `systemctl --user is-active` checks. It does not use a shell to start/stop services.
- Model prompts pass through the router to the configured local backends. Protect logs, screenshots and state when sharing.
- This is a preliminary publication review, not an independent security audit.

## Historical hardware evidence

The maintained private deployment notes record real lease cycles on 2026-11-01/02, including CPU handoff and return to GPU, with image/video jobs. Those tests were not rerun for this package. Reported render wall times include SDXL 1024 image 81 s, FLUX 512 image 213 s and LTX motion 512x320/97 frames 360 s. These are specific old runs, not portable benchmarks or current guarantees.

## License

MIT — see [LICENSE](LICENSE). Commercial use, modification and redistribution are permitted under its terms. No support or warranty is promised.

This standalone repository contains the manager, router, GUI, tests and example units, not the Open Higgsfield application. The auth/JWT/config helpers were initially built as part of the author's local studio integration, then reused here. Build-history review identified them as local additions rather than tracked upstream application files. The project was developed with AI assistance. No model weights or rendered personal media are included; third-party software and model licenses remain separate.

## Project status and feedback

Experimental, manually deployed software, not a production-ready package. Start with the isolated tests or simulated GUI. Hardware budgets must be calibrated before real use. There is no current handoff video in this repository; the simulated GUI is not physical-GPU benchmark evidence.

Bug reports and non-sensitive test results are welcome via [GitHub Issues](https://github.com/driftverse/hermes-gpu-manager/issues). Include your Node/Ollama versions, GPU, reproduction steps and sanitized errors. Never include tokens, private prompts, state files or personal media.

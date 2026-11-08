// Pure placement planner. No I/O.
//
// Walks the ordered workload list; every ACTIVE workload takes min(fullGpuMiB, remaining).
//   full allocation                         -> mode 'gpu'
//   less, allowPartial, >= minUsefulGpuMiB  -> mode 'partial' (gpuLayers in [1, layers-1])
//   otherwise                               -> mode 'cpu' (0 MiB)
// Inactive workloads are 'idle' with 0 MiB and consume nothing.
//
// Budget = gpuTotalMiB - max(reservedMiB, externalUsedMiB). `reservedMiB` already covers the
// desktop plus a safety margin; a measured non-managed usage above it can only shrink the budget
// (never grow it), and the two are not summed so the desktop is not counted twice.

const nonNeg = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

function partialLayers(w, alloc) {
  if (!Number.isInteger(w.layers) || w.layers < 2 || !(w.fullGpuMiB > 0)) return 0;
  const layers = Math.floor((w.layers * alloc) / w.fullGpuMiB);
  return Math.min(w.layers - 1, Math.max(1, layers));
}

export function planWorkloads({ workloads, gpuTotalMiB, reservedMiB, externalUsedMiB = 0 }) {
  const budgetMiB = Math.max(0, nonNeg(gpuTotalMiB) - Math.max(nonNeg(reservedMiB), nonNeg(externalUsedMiB)));
  let remaining = budgetMiB;
  let higherActive = [];
  const placements = [];

  for (const w of workloads) {
    const base = { id: w.id, kind: w.kind };
    if (!w.active) {
      placements.push({ ...base, mode: 'idle', gpuMiB: 0, gpuLayers: 0, reason: 'Not running, so it holds no GPU memory.' });
      continue;
    }
    const need = nonNeg(w.fullGpuMiB);
    const alloc = Math.min(need, remaining);
    const heldBy = higherActive.length ? ` after ${higherActive.join(', ')}` : '';

    if (alloc >= need) {
      remaining -= alloc;
      placements.push({ ...base, mode: 'gpu', gpuMiB: alloc, gpuLayers: null, reason: `Fits fully on the GPU (${alloc} MiB).` });
    } else if (w.allowPartial && alloc >= nonNeg(w.minUsefulGpuMiB) && alloc > 0 && partialLayers(w, alloc) > 0) {
      const gpuLayers = partialLayers(w, alloc);
      remaining -= alloc;
      placements.push({
        ...base,
        mode: 'partial',
        gpuMiB: alloc,
        gpuLayers,
        reason: `Only ${alloc} of ${need} MiB are left${heldBy}, so ${gpuLayers} of ${w.layers} layers run on the GPU and the rest on the CPU.`,
      });
    } else {
      const why = !w.allowPartial
        ? 'it cannot be split between GPU and CPU'
        : alloc < nonNeg(w.minUsefulGpuMiB)
          ? `a split needs at least ${nonNeg(w.minUsefulGpuMiB)} MiB to be worthwhile`
          : 'its layer count is unknown, so it cannot be split';
      placements.push({
        ...base,
        mode: 'cpu',
        gpuMiB: 0,
        gpuLayers: 0,
        reason: `Only ${alloc} of ${need} MiB of GPU are left${heldBy} and ${why}; running on the CPU.`,
      });
    }
    higherActive = [...higherActive, w.id];
  }
  return { placements, freeMiB: remaining, budgetMiB };
}

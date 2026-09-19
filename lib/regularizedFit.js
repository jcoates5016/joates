// A real, jointly-estimated alternative to testing each backtested factor one at a time (scripts/backtest.js's
// two-proportion z-test on isolated with/without buckets). Testing factors independently has a real blind spot:
// two factors that are correlated with each other (e.g. a hot-streak player is often also a high-snap-share
// player) each get "credit" for the same underlying signal when tested alone, which can make both look real even
// when only one is doing the actual work — exactly the kind of double-counting a single combined logistic model
// is built to catch, because it has to explain the SAME outcome with every factor competing for credit at once,
// not one at a time in isolation.
//
// EARLIER DESIGN, AND WHY IT CHANGED: this file originally fit an L1-regularized (lasso) path and picked a
// lambda via k-fold cross-validation — either the loss-minimizing point ("lambda.min") or the more conservative
// "1-SE rule". Both were tried against real backtest data and both miscalibrated in opposite directions: the
// 1-SE rule pruned real-but-modest effects to exactly 0 (caught by this file's own dry-run.js synthetic test —
// a clean, correctly-signed synthetic effect with a huge, obvious sample behind it still got zeroed for extra
// sparsity), while lambda.min essentially pruned NOTHING — on a real single-season sandbox run, factors the
// independent z-test rejected at p=0.8, p=0.5, p=0.4 all still got real nonzero coefficients, because a lasso's
// cross-validated log-loss surface is very flat for small coefficients near zero and doesn't reliably separate
// "genuinely no effect" from "tiny but real effect" the way this app actually needs it to. Neither result is
// usable for a tool real money rides on, and there's no principled middle lambda to pick that isn't just
// arbitrary tuning against one dataset.
//
// CURRENT DESIGN: a single joint (essentially unregularized — see `ridge` below) logistic fit across every
// factor at once, with a Wald significance test per coefficient, pruning at the same p<0.05 bar
// scripts/backtest.js's own two-proportion z-test already uses. This keeps the whole point of joint estimation
// (every factor's coefficient is the one that best explains the outcome GIVEN every other factor is already in
// the model, so a redundant factor's estimated effect — and its standard error — reflect that overlap) while
// reusing an already-established, auditable significance bar instead of a lambda grid search. The tradeoff is
// the standard one for Wald tests under real multicollinearity: two strongly correlated real factors can each
// come out with an inflated standard error and therefore individually miss significance even though their total
// combined effect is real and large — see this file's own header note on fitJointLogisticWithWaldTest and
// dry-run.js's synthetic test for how that's checked (by combined weight across a correlated pair, not by
// requiring each one to be individually significant).
//
// The core solver (fitL1Logistic) is standard L1-regularized logistic regression fit by coordinate descent — the
// same algorithm family glmnet (the standard R/Python tool for this) uses, hand-rolled here rather than pulled
// in as a dependency so it stays auditable and dependency-free like every other stats routine in this codebase
// (see scripts/backtest.js's own erf/normalCDF approximation for the same reasoning). It's kept general (lambda
// and an optional ridge term) because fitJointLogisticWithWaldTest below calls it at lambda=0 — a small ridge
// term is all that's left in play, purely for numerical conditioning against near-duplicate columns, not for
// variable selection.
//
// The algorithm (glmnet's IRLS + coordinate descent, "Regularization Paths for Generalized Linear Models via
// Coordinate Descent", Friedman/Hastie/Tibshirani 2010):
//   1. Outer loop: linearize the logistic log-likelihood around the current fit into a weighted least-squares
//      problem (the standard IRLS working response/weights).
//   2. Inner loop: solve that weighted least-squares problem (with L1 penalty, when lambda > 0) via cyclic
//      coordinate descent — one feature at a time, with a closed-form soft-thresholding update, holding every
//      other coefficient fixed.
//   3. Repeat until the fit stops changing.
// A running "linear predictor" (`eta`) is maintained incrementally rather than recomputed from scratch on every
// coordinate update, which is what keeps a full sweep O(n * p) instead of O(n * p^2) — the difference between
// this finishing in well under a second and taking minutes on a real multi-season sample.

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
function softThreshold(x, lambda) { return Math.sign(x) * Math.max(Math.abs(x) - lambda, 0); }

// Abramowitz & Stegun 7.1.26 approximation — the exact same one scripts/backtest.js's own twoProportionZTest
// uses, duplicated here (not imported — this file has no dependency on scripts/) so both this joint Wald test and
// the independent z-test compute p-values the same way and stay directly comparable in the diagnostic table
// scripts/backtest.js prints. Accurate to ~1.5e-7, plenty for a p-value used as a keep/prune gate.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normalCDF(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

// Every feature here is a 0/1 "did this factor's condition fire" indicator (same shape scripts/backtest.js's
// with/without buckets already use), so standardizing means centering on prevalence and scaling by its own
// standard deviation — a factor that fires on 60% of rows and one that fires on 2% of rows would otherwise get
// penalized very unevenly by the same shared lambda/ridge. A feature that never varies (std 0, e.g. always 0 in a
// tiny synthetic sample) gets std=1 as a safe fallback so it's just treated like any other, rather than dividing
// by zero.
function standardizeColumns(X) {
  const n = X.length, p = X[0]?.length || 0;
  const means = new Array(p).fill(0), stds = new Array(p).fill(1);
  for (let j = 0; j < p; j++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += X[i][j];
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (X[i][j] - mean) ** 2;
    variance /= n;
    means[j] = mean;
    stds[j] = Math.sqrt(variance) || 1;
  }
  const Xs = X.map(row => row.map((v, j) => (v - means[j]) / stds[j]));
  return { Xs, means, stds };
}

// Fits L1-penalized (or, at lambda=0, plain ridge-conditioned) logistic regression at one fixed lambda, on
// already-standardized features. `ridge` is a small L2 term added purely for numerical conditioning against
// near-duplicate/collinear columns — it is NOT used for variable selection (lambda is), and fitJointLogisticWith
// WaldTest below relies on it being small enough not to meaningfully bias the fit away from the true MLE.
// Returns the intercept and per-feature coefficients IN STANDARDIZED SPACE — callers translate back to the raw
// 0/1-indicator scale (beta_raw = beta_std / std) before using them the way lib/probability.js's nudges expect.
export function fitL1Logistic(Xs, y, lambda, { ridge = 0, outerIters = 25, innerIters = 60, tol = 1e-6 } = {}) {
  const n = Xs.length, p = Xs[0]?.length || 0;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  const clippedMeanY = Math.min(Math.max(meanY, 1e-6), 1 - 1e-6);
  let intercept = Math.log(clippedMeanY / (1 - clippedMeanY));
  let beta = new Array(p).fill(0);
  const eta = new Array(n).fill(intercept);
  let prevDeviance = Infinity;

  for (let outer = 0; outer < outerIters; outer++) {
    // IRLS working response/weights, linearizing the log-likelihood around the current fit.
    const w = new Array(n), z = new Array(n);
    let deviance = 0;
    for (let i = 0; i < n; i++) {
      const pi = Math.min(Math.max(sigmoid(eta[i]), 1e-6), 1 - 1e-6);
      w[i] = pi * (1 - pi);
      z[i] = eta[i] + (y[i] - pi) / w[i];
      deviance += -(y[i] * Math.log(pi) + (1 - y[i]) * Math.log(1 - pi));
    }

    for (let inner = 0; inner < innerIters; inner++) {
      // Intercept is never penalized — plain weighted-mean update.
      let sumW = 0, sumWResid = 0;
      for (let i = 0; i < n; i++) { sumW += w[i]; sumWResid += w[i] * (z[i] - (eta[i] - intercept)); }
      const newIntercept = sumW > 0 ? sumWResid / sumW : intercept;
      const deltaInt = newIntercept - intercept;
      if (deltaInt !== 0) { for (let i = 0; i < n; i++) eta[i] += deltaInt; intercept = newIntercept; }

      let maxChange = 0;
      for (let j = 0; j < p; j++) {
        let num = 0, den = 0;
        for (let i = 0; i < n; i++) {
          const xij = Xs[i][j];
          if (xij === 0) continue; // sparse-friendly: most factors are 0 on most rows
          const partialResid = z[i] - (eta[i] - xij * beta[j]); // residual with factor j's own contribution removed
          num += w[i] * xij * partialResid;
          den += w[i] * xij * xij;
        }
        num /= n; den /= n;
        const newBeta = (den + ridge) > 0 ? softThreshold(num, lambda) / (den + ridge) : 0;
        const delta = newBeta - beta[j];
        if (delta !== 0) {
          for (let i = 0; i < n; i++) { if (Xs[i][j] !== 0) eta[i] += Xs[i][j] * delta; }
          beta[j] = newBeta;
          maxChange = Math.max(maxChange, Math.abs(delta));
        }
      }
      if (maxChange < tol) break;
    }
    if (Math.abs(prevDeviance - deviance) < tol * n) break;
    prevDeviance = deviance;
  }
  return { intercept, beta };
}

// Gauss-Jordan matrix inversion with partial pivoting — used to invert the small (numFactors+1)-square Fisher
// information matrix below. With ~16-20 backtested factors this is a tiny, fast matrix; nothing fancier than
// straightforward elimination is needed.
function invertMatrix(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) pivotRow = r;
    }
    if (pivotRow !== col) { const tmp = M[col]; M[col] = M[pivotRow]; M[pivotRow] = tmp; }
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-10) continue; // near-singular column (e.g. a factor with ~zero variance) — leave its
    // row as an identity-ish placeholder rather than blowing up on a division by near-zero; its resulting
    // standard error will come out very large, which correctly reads as "not significant" rather than crashing.
    for (let j = 0; j < 2 * n; j++) M[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

// The actual entry point scripts/backtest.js uses: a single joint logistic fit across every factor at once (see
// this file's header comment for the full rationale and the two miscalibrated alternatives this replaced), with
// a Wald significance test per coefficient — z = beta / se(beta), p-value from the same erf/normalCDF
// approximation scripts/backtest.js's own independent z-test uses, so both are read on the same scale.
//
// Standard errors come from the inverse Fisher information at the converged fit, (X_aug^T W X_aug)^-1, where
// X_aug prepends an intercept column of 1s and W = diag(pi_i * (1 - pi_i)) evaluated at the final fit — the
// standard asymptotic covariance estimate for a GLM's maximum-likelihood fit (see e.g. McCullagh & Nelder,
// "Generalized Linear Models", 2nd ed., ch. 2.5). `ridge` is small enough (default 1e-4, applied only for
// conditioning against near-collinear columns) that this remains a good approximation of the true unregularized
// MLE's covariance, not a meaningfully biased ridge-estimator's.
//
// KNOWN LIMITATION (see header comment): two strongly correlated real factors can each get an inflated standard
// error from sharing variance, and can individually miss the p<0.05 bar even when their combined effect is real
// and large. This is the accepted tradeoff for a Wald-test-based joint fit — verified in dry-run.js's synthetic
// test by checking that a correlated pair's COMBINED coefficient weight still recovers the true injected signal,
// not that each one individually clears significance.
export function fitJointLogisticWithWaldTest(X, y, keys, { ridge = 1e-4, significanceP = 0.05 } = {}) {
  const { Xs, stds } = standardizeColumns(X);
  const n = Xs.length, p = keys.length;
  const fit = fitL1Logistic(Xs, y, 0, { ridge });

  const w = new Array(n);
  for (let i = 0; i < n; i++) {
    const eta = fit.intercept + Xs[i].reduce((s, x, j) => s + x * fit.beta[j], 0);
    const pi = Math.min(Math.max(sigmoid(eta), 1e-6), 1 - 1e-6);
    w[i] = pi * (1 - pi);
  }
  const dim = p + 1; // +1 for the intercept column
  const M = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (let i = 0; i < n; i++) {
    const row = [1, ...Xs[i]];
    for (let a = 0; a < dim; a++) {
      if (row[a] === 0) continue;
      for (let b = a; b < dim; b++) M[a][b] += w[i] * row[a] * row[b];
    }
  }
  for (let a = 0; a < dim; a++) for (let b = 0; b < a; b++) M[a][b] = M[b][a]; // fill the symmetric lower triangle
  const Minv = invertMatrix(M);

  const byKey = {};
  for (let j = 0; j < p; j++) {
    const variance = Minv[j + 1][j + 1]; // skip row/col 0, the intercept
    const se = Math.sqrt(Math.max(variance, 0));
    const z = se > 0 ? fit.beta[j] / se : 0;
    const pValue = se > 0 ? 2 * (1 - normalCDF(Math.abs(z))) : 1;
    const significant = pValue < significanceP;
    byKey[keys[j]] = {
      standardizedBeta: fit.beta[j],
      rawBeta: fit.beta[j] / stds[j],
      se, z, p: pValue, significant
    };
  }
  return { intercept: fit.intercept, byKey };
}

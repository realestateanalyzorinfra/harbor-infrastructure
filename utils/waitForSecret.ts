import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@kubernetes/client-node";

/**
 * Input arguments for WaitForSecret resource
 */
export interface WaitForSecretArgs {
    /**
     * Name of the Kubernetes Secret to wait for
     */
    secretName: string;

    /**
     * Namespace where the Secret should exist
     */
    namespace: string;

    /**
     * Kubeconfig as a YAML string for authenticating to the cluster
     * Note: This must be a plain string, not a Pulumi Output
     */
    kubeconfig: string;

    /**
     * Maximum number of retry attempts
     * @default 20
     */
    maxRetries?: number;

    /**
     * Initial delay in milliseconds before first retry
     * @default 2000 (2 seconds)
     */
    initialDelayMs?: number;

    /**
     * Maximum delay in milliseconds between retries
     * @default 15000 (15 seconds)
     */
    maxDelayMs?: number;
}

/**
 * Provider implementation for WaitForSecret dynamic resource
 *
 * This provider polls for a Kubernetes Secret to exist, using exponential
 * backoff retry logic. It's designed to handle race conditions where a
 * Secret is created asynchronously by a controller (e.g., ObjectBucketClaim
 * controller creating a Secret after the OBC resource is created).
 */
class WaitForSecretProvider implements pulumi.dynamic.ResourceProvider {
    async create(inputs: WaitForSecretArgs): Promise<pulumi.dynamic.CreateResult> {
        const secretName = inputs.secretName;
        const namespace = inputs.namespace;
        const maxRetries = inputs.maxRetries || 20;
        const initialDelayMs = inputs.initialDelayMs || 2000;
        const maxDelayMs = inputs.maxDelayMs || 15000;

        console.log(`[WaitForSecret] Waiting for Secret "${secretName}" in namespace "${namespace}"...`);
        console.log(`[WaitForSecret] Configuration: maxRetries=${maxRetries}, initialDelay=${initialDelayMs}ms, maxDelay=${maxDelayMs}ms`);

        // Initialize Kubernetes client from kubeconfig
        const kc = new k8s.KubeConfig();
        kc.loadFromString(inputs.kubeconfig);
        const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

        let currentDelayMs = initialDelayMs;
        let attempt = 0;
        const startTime = Date.now();

        // Polling loop with exponential backoff
        for (attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log(`[WaitForSecret] Attempt ${attempt}/${maxRetries}: Checking if Secret exists...`);

                // Attempt to get the Secret using native Kubernetes API
                const response = await k8sApi.readNamespacedSecret(secretName, namespace);

                // If we got here, Secret exists!
                const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`[WaitForSecret] ✓ Success: Secret "${secretName}" found after ${attempt} attempts (${elapsedSeconds}s elapsed)`);

                // Extract Secret data (already base64-encoded by Kubernetes)
                const secretData = response.body.data || {};

                return {
                    id: `${namespace}/${secretName}`,
                    outs: {
                        secretName: secretName,
                        namespace: namespace,
                        secretData: secretData,
                        attemptsRequired: attempt,
                        elapsedSeconds: parseFloat(elapsedSeconds),
                    },
                };
            } catch (error: any) {
                const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);

                // Check if this is a "not found" error (HTTP 404)
                if (error.statusCode === 404 || (error.message && error.message.includes("not found"))) {
                    console.log(
                        `[WaitForSecret] Attempt ${attempt}/${maxRetries}: Secret not found, ` +
                        `retrying in ${currentDelayMs}ms... (${elapsedSeconds}s elapsed)`
                    );

                    // Not the last attempt - wait and retry
                    if (attempt < maxRetries) {
                        await this.sleep(currentDelayMs);

                        // Exponential backoff: double the delay, but cap at maxDelayMs
                        currentDelayMs = Math.min(currentDelayMs * 2, maxDelayMs);
                    }
                } else {
                    // Unexpected error (not a "not found" error)
                    const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(1);
                    throw new Error(
                        `[WaitForSecret] ✗ Unexpected error while checking Secret "${secretName}" ` +
                        `in namespace "${namespace}" (attempt ${attempt}/${maxRetries}, ` +
                        `${elapsedTotal}s elapsed): ${error.message}`
                    );
                }
            }
        }

        // All retries exhausted
        const totalElapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
        throw new Error(
            `[WaitForSecret] ✗ Timeout: Secret "${secretName}" in namespace "${namespace}" ` +
            `did not appear after ${maxRetries} attempts (${totalElapsedSeconds}s elapsed). ` +
            `This likely indicates an issue with the ObjectBucketClaim controller or ` +
            `the Secret creation process. Please check the OBC controller logs and ` +
            `verify that the ObjectBucketClaim resource was created successfully.`
        );
    }

    /**
     * Sleep for the specified number of milliseconds
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

/**
 * WaitForSecret resource
 *
 * A Pulumi dynamic resource that waits for a Kubernetes Secret to exist
 * before proceeding. Uses exponential backoff polling to handle race
 * conditions where Secrets are created asynchronously by controllers.
 *
 * Example usage:
 * ```typescript
 * const obcSecret = new WaitForSecret("harbor-bucket-credentials", {
 *     secretName: "harbor-registry-bucket",
 *     namespace: "harbor",
 *     kubeconfig: kubeconfigYaml, // Plain string, not a Pulumi Output
 *     maxRetries: 20,
 *     initialDelayMs: 2000,
 *     maxDelayMs: 15000,
 * });
 *
 * // Access the Secret data
 * const accessKey = obcSecret.secretData.apply(data => data["AWS_ACCESS_KEY_ID"]);
 * ```
 */
export class WaitForSecret extends pulumi.dynamic.Resource {
    /**
     * The Secret data as a dictionary of base64-encoded values
     */
    public readonly secretData!: pulumi.Output<{ [key: string]: string }>;

    /**
     * Name of the Secret
     */
    public readonly secretName!: pulumi.Output<string>;

    /**
     * Namespace of the Secret
     */
    public readonly namespace!: pulumi.Output<string>;

    /**
     * Number of attempts required to find the Secret
     */
    public readonly attemptsRequired!: pulumi.Output<number>;

    /**
     * Total elapsed time in seconds
     */
    public readonly elapsedSeconds!: pulumi.Output<number>;

    constructor(
        name: string,
        args: WaitForSecretArgs,
        opts?: pulumi.CustomResourceOptions
    ) {
        super(
            new WaitForSecretProvider(),
            name,
            {
                secretData: undefined,
                secretName: args.secretName,
                namespace: args.namespace,
                kubeconfig: args.kubeconfig,
                maxRetries: args.maxRetries,
                initialDelayMs: args.initialDelayMs,
                maxDelayMs: args.maxDelayMs,
                attemptsRequired: undefined,
                elapsedSeconds: undefined,
            },
            opts
        );
    }
}

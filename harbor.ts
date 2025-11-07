import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";
import { WaitForSecret } from "./utils/waitForSecret";

// Configuration and environment checks
const config = new pulumi.Config();
const k8sNamespace = "harbor";

const kubeconfigStack = new pulumi.StackReference("egulatee/kubeconfig/prod");
const rookCephStack = new pulumi.StackReference("egulatee/rook-ceph/dev");
const traefikStack = new pulumi.StackReference("egulatee/traefik-ingress/prod");

const k8sProvider = new kubernetes.Provider("k8s-provider", {
    kubeconfig: kubeconfigStack.requireOutput("kubeconfig"),
    enableServerSideApply: false,
});

const HarborProvider: pulumi.dynamic.ResourceProvider = {
    async create(inputs) {
        return { id: "harbor", outs: {} };
    },
};

export interface HarborArgs {
    // No args needed - credentials managed by Pulumi config
}

export class Harbor extends pulumi.dynamic.Resource {
    public chart;
    public k8sProvider;
    public harborAdminSecret;
    public databaseSecret;
    public postgresql;
    public adminPassword;

    constructor(name: string, args: HarborArgs, opts?: pulumi.ComponentResourceOptions) {
        super(HarborProvider, name, {}, opts);

        // Export k8sProvider for use in index.ts
        this.k8sProvider = k8sProvider;

        // Create a namespace
        const namespace = new kubernetes.core.v1.Namespace(
            "harbor",
            {
                metadata: {
                    name: k8sNamespace,
                },
            },
            {
                provider: k8sProvider,
                parent: this,
            }
        );

        // Get passwords from Pulumi config (replaces Vault/ESO)
        const adminPassword = config.requireSecret("harborAdminPassword");
        const dbPassword = config.requireSecret("harborDatabasePassword");

        // Create K8s Secrets directly (replaces ESO)
        const harborAdminSecret = new kubernetes.core.v1.Secret(
            "harbor-admin-credentials",
            {
                metadata: {
                    name: "harbor-admin-credentials",
                    namespace: k8sNamespace,
                },
                stringData: {
                    HARBOR_ADMIN_PASSWORD: adminPassword,
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace],
            }
        );

        const databaseSecret = new kubernetes.core.v1.Secret(
            "harbor-database-credentials",
            {
                metadata: {
                    name: "harbor-database-credentials",
                    namespace: k8sNamespace,
                },
                stringData: {
                    "postgres-password": dbPassword,
                    "password": dbPassword,
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace],
            }
        );

        // Export secrets and password for use in index.ts
        this.harborAdminSecret = harborAdminSecret;
        this.databaseSecret = databaseSecret;
        this.adminPassword = adminPassword;

        // Create S3 bucket using ObjectBucketClaim (Kubernetes-native way)
        const harborBucketClaim = new kubernetes.apiextensions.CustomResource(
            "harbor-registry-bucket",
            {
                apiVersion: "objectbucket.io/v1alpha1",
                kind: "ObjectBucketClaim",
                metadata: {
                    name: "harbor-registry-bucket",
                    namespace: k8sNamespace,
                },
                spec: {
                    bucketName: "harbor-registry",
                    storageClassName: "ceph-s3-bucket",
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace],
            }
        );

        // Get bucket credentials from OBC-generated secret
        // The ObjectBucketClaim creates bucket-specific credentials in the harbor-registry-bucket secret
        // Use WaitForSecret to poll for the Secret with exponential backoff (fixes race condition)
        const kubeconfig = kubeconfigStack.requireOutput("kubeconfig");
        const obcSecret = new WaitForSecret(
            "harbor-bucket-credentials-waiter",
            {
                secretName: "harbor-registry-bucket",
                namespace: k8sNamespace,
                kubeconfig: kubeconfig as any, // Pulumi will unwrap the Output before passing to the provider
                maxRetries: 20,
                initialDelayMs: 2000,
                maxDelayMs: 15000,
            },
            {
                parent: this,
                dependsOn: [harborBucketClaim],
            }
        );

        // Extract OBC credentials instead of using RGW admin credentials
        const obcAccessKey = obcSecret.secretData.apply(data => data["AWS_ACCESS_KEY_ID"]);
        const obcSecretKey = obcSecret.secretData.apply(data => data["AWS_SECRET_ACCESS_KEY"]);

        // Get RGW admin credentials from rook-ceph stack for bucket linking job
        // These are admin credentials that have access to all buckets
        const rgwAccessKey = rookCephStack.requireOutput("rgwAccessKey");
        const rgwSecretKey = rookCephStack.requireOutput("rgwSecretKey");

        // Link bucket to RGW admin user so it has access
        // Use exec into the rook-ceph-tools pod instead of a Job
        const linkBucket = new kubernetes.batch.v1.Job(
            "link-harbor-bucket",
            {
                metadata: {
                    name: "link-harbor-bucket",
                    namespace: "rook-ceph",
                },
                spec: {
                    template: {
                        spec: {
                            serviceAccountName: "rook-ceph-system",
                            containers: [{
                                name: "link-bucket",
                                image: "rook/ceph:v1.17.8",
                                command: ["/bin/bash", "-c"],
                                args: [
                                    "kubectl exec -n rook-ceph deploy/rook-ceph-tools -- radosgw-admin bucket link --bucket=harbor-registry --uid=rgw-admin-ops-user || " +
                                    "echo 'Bucket linking will be done manually or bucket already linked'"
                                ],
                                env: [{
                                    name: "KUBECONFIG",
                                    value: "/var/run/secrets/kubernetes.io/serviceaccount/token",
                                }],
                            }],
                            restartPolicy: "Never",
                        },
                    },
                    backoffLimit: 1,
                    ttlSecondsAfterFinished: 300,
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [harborBucketClaim],
                deleteBeforeReplace: true,
            }
        );

        // Deploy external PostgreSQL using Bitnami Helm Chart
        const postgresql = new kubernetes.helm.v3.Release(
            "harbor-postgresql",
            {
                chart: "postgresql",
                version: "18.1.1",
                namespace: k8sNamespace,
                repositoryOpts: {
                    repo: "https://charts.bitnami.com/bitnami",
                },
                values: {
                    // Set fixed fullname to avoid random hash suffix
                    fullnameOverride: "harbor-postgresql",
                    auth: {
                        // Use ESO-managed credentials
                        existingSecret: "harbor-database-credentials",
                        secretKeys: {
                            adminPasswordKey: "postgres-password",
                            userPasswordKey: "password"
                        },
                        username: "harbor",
                        database: "registry"  // Primary database
                    },
                    primary: {
                        persistence: {
                            enabled: true,
                            storageClass: "ceph-replicated",
                            size: "5Gi"
                        },
                        resources: {
                            requests: {
                                memory: "512Mi",
                                cpu: "500m"
                            },
                            limits: {
                                memory: "1Gi",
                                cpu: "1000m"
                            }
                        },
                        // Initialize additional databases for Harbor
                        initdb: {
                            scripts: {
                                "init-harbor-databases.sql": `
                                    -- Create additional databases required by Harbor
                                    CREATE DATABASE IF NOT EXISTS notary_server;
                                    CREATE DATABASE IF NOT EXISTS notary_signer;

                                    -- Grant privileges to harbor user
                                    GRANT ALL PRIVILEGES ON DATABASE registry TO harbor;
                                    GRANT ALL PRIVILEGES ON DATABASE notary_server TO harbor;
                                    GRANT ALL PRIVILEGES ON DATABASE notary_signer TO harbor;
                                `
                            }
                        }
                    },
                    metrics: {
                        enabled: true,
                        serviceMonitor: {
                            enabled: true
                        }
                    }
                }
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace, databaseSecret],
                customTimeouts: {
                    create: "10m",
                    update: "10m",
                    delete: "10m"
                }
            }
        );

        // Export PostgreSQL for use in index.ts
        this.postgresql = postgresql;

        // Use Helm to install Harbor with external database
        this.chart = new kubernetes.helm.v3.Release(
            "harbor",
            {
                chart: "harbor",
                name: "harbor",
                repositoryOpts: {
                    repo: "https://helm.goharbor.io",
                },
                version: "1.18.0",
                namespace: k8sNamespace,
                values: {
                    externalURL: "https://harbor.egyrllc.com",
                    // Use ESO-managed admin password from K8s Secret
                    existingSecretAdminPassword: "harbor-admin-credentials",
                    existingSecretAdminPasswordKey: "HARBOR_ADMIN_PASSWORD",
                    global: {
                        storageClass: "ceph-replicated",  // For Redis, Trivy, JobService
                        updateTimestamp: new Date().toISOString(),  // Force Helm update
                    },
                    // Configure S3 storage for registry (images)
                    persistence: {
                        imageChartStorage: {
                            type: "s3",
                            disableredirect: true,  // Disable S3 redirect for Ceph RGW
                            s3: {
                                region: "us-east-1",  // Ceph RGW doesn't use regions, but Harbor requires it
                                bucket: "harbor-registry",
                                // Use OBC-generated bucket-specific credentials instead of admin credentials
                                accesskey: obcAccessKey.apply(k =>
                                    Buffer.from(k as string, "base64").toString()
                                ),
                                secretkey: obcSecretKey.apply(k =>
                                    Buffer.from(k as string, "base64").toString()
                                ),
                                regionendpoint: "http://rook-ceph-rgw-s3-objectstore.rook-ceph.svc:80",
                                encrypt: false,
                                secure: false,  // Using HTTP internally
                                v4auth: true,
                                chunksize: "5242880",  // 5MB chunks
                                rootdirectory: "/registry",
                                skipverify: true,  // Skip TLS verification for internal HTTP
                                multipartcopychunksize: "5242880",
                                multipartcopymaxconcurrency: 50,
                                multipartcopythresholdsize: "5242880",
                            },
                        },
                    },
                    // Configure external PostgreSQL database
                    database: {
                        type: "external",
                        external: {
                            host: "harbor-postgresql.harbor.svc.cluster.local",
                            port: "5432",
                            username: "harbor",
                            // Use ESO-managed database credentials
                            existingSecret: "harbor-database-credentials",
                            coreDatabase: "registry",
                            notaryServerDatabase: "notary_server",
                            notarySignerDatabase: "notary_signer",
                            sslmode: "disable"  // Plain connections within cluster
                        }
                    },
                    expose: {
                        type: "ingress",
                        tls: {
                            enabled: true,
                            certSource: "auto",
                            auto: {
                                commonName: "harbor.egyrllc.com",
                            },
                        },
                        metrics: {
                            enabled: true,
                            serviceMonitor: {
                                enabled: true,
                            },
                        },
                        ingress: {
                            className: traefikStack.requireOutput("ingressClassName"),
                            hosts: {
                                core: "harbor.egyrllc.com",
                            },
                            annotations: {
                                "cert-manager.io/cluster-issuer": "zerossl-prod",
                                "external-dns.alpha.kubernetes.io/hostname": "harbor.egyrllc.com.",
                                // Add timeout annotations for large image uploads (800MB+)
                                // Fixes "tls: bad record MAC" errors during GitHub Actions pushes
                                // See: https://github.com/realestateanalyzorinfra/harbor-infrastructure/issues/8
                                "traefik.ingress.kubernetes.io/request-timeout": "1800s",  // 30 minutes for Traefik
                                "nginx.ingress.kubernetes.io/proxy-read-timeout": "1800",   // 30 minutes (fallback for NGINX)
                                "nginx.ingress.kubernetes.io/proxy-send-timeout": "1800",   // 30 minutes (fallback for NGINX)
                            },
                        },
                    },
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace, postgresql, harborAdminSecret, databaseSecret, linkBucket, harborBucketClaim],
                customTimeouts: {
                    create: "10m",
                    update: "10m",
                    delete: "10m",
                },
            }
        );
    }
}
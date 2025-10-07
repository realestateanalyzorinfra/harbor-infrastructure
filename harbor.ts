import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

// Configuration and environment checks
const k8sNamespace = "harbor";

const kubeconfigStack = new pulumi.StackReference("egulatee/kubeconfig/dev");
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
    adminPassword: pulumi.Input<string>;
}

export class Harbor extends pulumi.dynamic.Resource {
    public chart;

    constructor(name: string, args: HarborArgs, opts?: pulumi.ComponentResourceOptions) {
        super(HarborProvider, name, {}, opts);

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

        // Get Ceph RGW S3 credentials from rook-ceph namespace
        const cephS3Secret = kubernetes.core.v1.Secret.get(
            "ceph-s3-credentials",
            "rook-ceph/rgw-admin-secret",
            { provider: k8sProvider }
        );

        // Create Harbor S3 secret from Ceph credentials
        const harborS3Secret = new kubernetes.core.v1.Secret(
            "harbor-s3-secret",
            {
                metadata: {
                    name: "harbor-s3-secret",
                    namespace: k8sNamespace,
                },
                type: "Opaque",
                data: {
                    accesskey: cephS3Secret.data.apply(d => d["accessKey"]),
                    secretkey: cephS3Secret.data.apply(d => d["secretKey"]),
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace],
            }
        );

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
                    generateBucketName: "harbor-registry",
                    storageClassName: "ceph-s3-bucket",
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace],
            }
        );

        // Use Helm to install Harbor with transformation to fix database init container
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
                    harborAdminPassword: args.adminPassword,
                    global: {
                        storageClass: "ceph-replicated",  // For PostgreSQL, Redis, Trivy, JobService
                    },
                    // Configure S3 storage for registry (images)
                    persistence: {
                        imageChartStorage: {
                            type: "s3",
                            s3: {
                                region: "us-east-1",  // Ceph RGW doesn't use regions, but Harbor requires it
                                bucket: "harbor-registry",
                                accesskey: harborS3Secret.data.apply(d =>
                                    Buffer.from(d["accesskey"] as string, "base64").toString()
                                ),
                                secretkey: harborS3Secret.data.apply(d =>
                                    Buffer.from(d["secretkey"] as string, "base64").toString()
                                ),
                                regionendpoint: "http://rook-ceph-rgw-s3-objectstore.rook-ceph.svc:80",
                                encrypt: false,
                                secure: false,  // Using HTTP internally
                                v4auth: true,
                                chunksize: "5242880",  // 5MB chunks
                                rootdirectory: "/registry",
                            },
                        },
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
                            hosts: {
                                core: "harbor.egyrllc.com",
                            },
                            annotations: {
                                "cert-manager.io/cluster-issuer": "zerossl-prod",
                                "external-dns.alpha.kubernetes.io/hostname": "harbor.egyrllc.com.",
                            },
                        },
                    },
                },
            },
            {
                provider: k8sProvider,
                parent: this,
                dependsOn: [namespace, harborS3Secret, harborBucketClaim],
                customTimeouts: {
                    create: "10m",
                    update: "10m",
                    delete: "10m",
                },
                transformations: [
                    (args: any) => {
                        // Fix the database StatefulSet init container
                        if (args.type === "kubernetes:apps/v1:StatefulSet" &&
                            args.name.includes("harbor-database")) {

                            const spec = args.props.spec;
                            if (spec && spec.template && spec.template.spec && spec.template.spec.initContainers) {
                                // Find the data-permissions-ensurer init container
                                const initContainers = spec.template.spec.initContainers;
                                const permissionsContainer = initContainers.find((c: any) =>
                                    c.name === "data-permissions-ensurer"
                                );

                                if (permissionsContainer) {
                                    // Fix the command to properly create directory and set permissions
                                    permissionsContainer.command = ["/bin/sh"];
                                    permissionsContainer.args = [
                                        "-c",
                                        "mkdir -p /var/lib/postgresql/data/pgdata && " +
                                        "chmod -R 700 /var/lib/postgresql/data/pgdata && " +
                                        "chown -R 999:999 /var/lib/postgresql/data/pgdata && " +
                                        "echo 'Database permissions fixed successfully' && " +
                                        "ls -la /var/lib/postgresql/data/"
                                    ];

                                    // Allow running as root to chown files
                                    if (permissionsContainer.securityContext) {
                                        permissionsContainer.securityContext.runAsNonRoot = false;
                                        permissionsContainer.securityContext.runAsUser = 0;
                                    }
                                }
                            }
                        }

                        return args;
                    }
                ],
            }
        );
    }
}
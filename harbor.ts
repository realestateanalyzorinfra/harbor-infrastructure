import * as pulumi from "@pulumi/pulumi";
import * as kubernetes from "@pulumi/kubernetes";

// Configuration and environment checks
const k8sNamespace = "harbor";

const kubeconfigStack = new pulumi.StackReference("egulatee/kubeconfig/dev");
const rookCephStack = new pulumi.StackReference("egulatee/rook-ceph/dev");

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

        // Get RGW admin credentials from rook-ceph stack
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
                                accesskey: rgwAccessKey.apply(k =>
                                    Buffer.from(k as string, "base64").toString()
                                ),
                                secretkey: rgwSecretKey.apply(k =>
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
                dependsOn: [namespace, harborBucketClaim, linkBucket],
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
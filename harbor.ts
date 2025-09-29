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

        // Use Helm to install Harbor
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
                        storageClass: "ceph-replicated",
                    },
                    persistence: {
                        persistentVolumeClaim: {
                            registry: {
                                size: "20Gi"
                            }
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
                dependsOn: [namespace],
                customTimeouts: {
                    create: "10m",
                    update: "10m",
                    delete: "10m",
                },
            }
        );
    }
}
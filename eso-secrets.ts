import * as kubernetes from "@pulumi/kubernetes";

/**
 * Creates ExternalSecret resources to sync credentials from Vault to Kubernetes
 * using the External Secrets Operator (ESO).
 *
 * All secrets are sourced from Vault (single source of truth) and synced to K8s
 * every 15 minutes by ESO.
 */
export function createExternalSecrets(
    namespace: string,
    k8sProvider: kubernetes.Provider
) {
    // Harbor admin credentials
    const harborAdminSecret = new kubernetes.apiextensions.CustomResource(
        "harbor-admin-credentials",
        {
            apiVersion: "external-secrets.io/v1beta1",
            kind: "ExternalSecret",
            metadata: {
                name: "harbor-admin-credentials",
                namespace: namespace,
            },
            spec: {
                refreshInterval: "15m",
                secretStoreRef: {
                    name: "vault-backend",
                    kind: "ClusterSecretStore"
                },
                target: {
                    name: "harbor-admin-credentials",
                    creationPolicy: "Owner"
                },
                data: [
                    {
                        secretKey: "HARBOR_ADMIN_PASSWORD",
                        remoteRef: {
                            key: "secret/harbor/prod",
                            property: "adminPassword"
                        }
                    }
                ]
            }
        },
        { provider: k8sProvider }
    );

    // Harbor database credentials
    const databaseSecret = new kubernetes.apiextensions.CustomResource(
        "harbor-database-credentials",
        {
            apiVersion: "external-secrets.io/v1beta1",
            kind: "ExternalSecret",
            metadata: {
                name: "harbor-database-credentials",
                namespace: namespace,
            },
            spec: {
                refreshInterval: "15m",
                secretStoreRef: {
                    name: "vault-backend",
                    kind: "ClusterSecretStore"
                },
                target: {
                    name: "harbor-database-credentials",
                    creationPolicy: "Owner"
                },
                data: [
                    {
                        secretKey: "postgres-password",
                        remoteRef: {
                            key: "secret/harbor-database/prod",
                            property: "postgresPassword"
                        }
                    },
                    {
                        secretKey: "password",
                        remoteRef: {
                            key: "secret/harbor-database/prod",
                            property: "postgresPassword"
                        }
                    }
                ]
            }
        },
        { provider: k8sProvider }
    );

    return { harborAdminSecret, databaseSecret };
}

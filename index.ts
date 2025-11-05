import * as pulumi from "@pulumi/pulumi";
import { Harbor } from "./harbor";
import * as pulumiharbor from "@pulumiverse/harbor";
import * as keycloak from "@pulumi/keycloak";
import * as kubernetes from "@pulumi/kubernetes";
import * as vault from "@pulumi/vault";

require("dotenv").config({ path: [".env.local", ".env"] });

// Environment variable checks
if (process.env.PULUMI_ACCESS_TOKEN == null) {
    throw new Error("No PULUMI_ACCESS_TOKEN env variable set");
}

// Generate random passwords and secrets (45 chars, alphanumeric [0-9, a-z, A-Z])
const generateRandomPassword = (length: number = 45): string => {
    return Array.from({length}, () =>
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        .charAt(Math.floor(Math.random() * 62))
    ).join('');
};

// Configuration
const config = new pulumi.Config();

// Reference keycloak stack
export const keycloakStack = new pulumi.StackReference("egulatee/keycloak/dev");

// Get outputs from keycloak stack
export const keycloakAdminUserId = keycloakStack.requireOutput("keycloakAdminUserId");
export const keycloakUrl = keycloakStack.requireOutput("keycloak_url");
const keycloakAdminPasswordFromStack = keycloakStack.requireOutput("keycloakAdminPassword");

// Export keycloak admin password
export const keycloakAdminPassword = keycloakAdminPasswordFromStack;

// Create Keycloak provider using the actual admin password from Keycloak stack
const keycloakProvider = new keycloak.Provider("keycloak", {
    clientId: "admin-cli",
    username: keycloakAdminUserId,
    password: keycloakAdminPasswordFromStack,
    url: keycloakUrl,
    realm: "master",
});

// Create Harbor Keycloak realm and client
const harborRealm = new keycloak.Realm(
    "Harbor",
    {
        realm: "Harbor",
    },
    { provider: keycloakProvider }
);

const harborClientId = "harbor";
const harborClient = new keycloak.openid.Client(
    harborClientId,
    {
        realmId: harborRealm.id,
        clientId: harborClientId,
        name: harborClientId,
        enabled: true,
        accessType: "CONFIDENTIAL",
        standardFlowEnabled: true,
        directAccessGrantsEnabled: true,
        validRedirectUris: ["https://harbor.egyrllc.com/c/oidc/callback"],
    },
    { provider: keycloakProvider, dependsOn: [harborRealm] }
);

// User, groups, and group memberships are created in harbor-permissions stack

// Create groups client scope for Harbor
const harborGroupClientScope = new keycloak.openid.ClientScope(
    "groups",
    {
        realmId: harborRealm.id,
        name: "groups",
        includeInTokenScope: true,
        description: "Groups the user is part of",
    },
    { provider: keycloakProvider, dependsOn: [harborClient] }
);

const harborGroupMapping = new keycloak.openid.GroupMembershipProtocolMapper(
    "groupmapper",
    {
        realmId: harborRealm.id,
        clientScopeId: harborGroupClientScope.id,
        claimName: "groups",
    },
    { provider: keycloakProvider, dependsOn: [harborClient] }
);

// Create Harbor instance (ESO-managed credentials)
let harbor = new Harbor("harbor", {});

// Configure Vault provider to read secrets
const vaultProvider = new vault.Provider("vault", {
    address: "http://vault-e4b365db.vault.svc.cluster.local:8200",
    // Vault token should be set via VAULT_TOKEN environment variable
    // or use Kubernetes auth if running in-cluster
});

// Get Harbor admin password from Vault using Pulumi Vault provider
// The Harbor Helm chart will use the ESO-synced K8s secret
// But the Pulumi provider needs the password to configure Harbor after deployment
const harborVaultSecret = vault.kv.getSecretV2Output({
    mount: "secret",
    name: "harbor/prod",
}, { provider: vaultProvider });

const harborAdminPassword = pulumi.secret(
    harborVaultSecret.apply(s => s.data["adminPassword"])
);

// Configure Harbor provider with password from Vault
let harborProvider = new pulumiharbor.Provider(
    "harborprovider",
    {
        url: "https://harbor.egyrllc.com",
        username: "admin",
        password: harborAdminPassword,
    },
    { dependsOn: [harbor, harbor.chart, harbor.harborAdminSecret] }
);

// Configure OIDC authentication
const configAuthResource = new pulumiharbor.ConfigAuth(
    "configAuthResource",
    {
        authMode: "oidc_auth",
        primaryAuthMode: false,
        oidcName: "Keycloak",
        oidcClientId: harborClient.clientId,
        oidcClientSecret: harborClient.clientSecret,
        oidcEndpoint: "https://keycloak.egyrllc.com/realms/Harbor",
        oidcScope: "openid,profile,email,offline_access",
        oidcUserClaim: "preferred_username",
        oidcAutoOnboard: true,
        oidcVerifyCert: true,
    },
    {
        provider: harborProvider,
        dependsOn: [harborProvider, harbor, harbor.chart, harborClient],
    }
);

// Create projects
const reaproject = new pulumiharbor.Project(
    "realestateanalyzor",
    {
        name: "realestateanalyzor",
        public: false,
        vulnerabilityScanning: true,
    },
    {
        provider: harborProvider,
        dependsOn: [harbor],
    }
);

// Configure DockerHub registry
const dockerhubregistry = new pulumiharbor.Registry(
    "dockerhub",
    {
        name: "docker_hub",
        endpointUrl: "https://hub.docker.com",
        providerName: "docker-hub"
    },
    { provider: harborProvider, dependsOn: [harbor] }
);

// Create proxy cache project
const proxycacheproject = new pulumiharbor.Project(
    "proxy-cache",
    {
        name: "proxy-cache",
        public: false,
        vulnerabilityScanning: false,
        registryId: dockerhubregistry.registryId
    },
    {
        provider: harborProvider,
        dependsOn: [harbor],
    }
);

// Create AI augmented software development project
const aiaugmentedsoftwaredevproject = new pulumiharbor.Project(
    "aiaugmentedsoftwaredev",
    {
        name: "aiaugmentedsoftwaredev",
        public: false,
        vulnerabilityScanning: true,
        forceDestroy: true,
    },
    {
        provider: harborProvider,
        dependsOn: [harbor],
    }
);

console.log("📋 Harbor Infrastructure deployed successfully!");
console.log("");
console.log("Next steps:");
console.log("1. Deploy the harbor-permissions stack to create users and robot accounts");
console.log("2. Visit Harbor at: https://harbor.egyrllc.com");

// Export Harbor registry information for external stack references
export const harborUrl = "https://harbor.egyrllc.com";
export const harborRegistryUrl = "harbor.egyrllc.com";
export const harborAdminPasswordExport = harborAdminPassword;

// Export project information for permissions stack
export const realestateanalyzorProjectName = "realestateanalyzor";
export const proxyCacheProjectName = "proxy-cache";
export const aiaugmentedProjectName = "aiaugmentedsoftwaredev";

// Export Keycloak realm and OIDC information for permissions stack
export const harborRealmId = harborRealm.id;
export const harborRealmName = harborRealm.realm;
export const oidcClientId = harborClient.clientId;
export const oidcClientSecret = harborClient.clientSecret;
import * as pulumi from "@pulumi/pulumi";
import { Harbor } from "./harbor";
import * as pulumiharbor from "@pulumiverse/harbor";
import * as keycloak from "@pulumi/keycloak";

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

// Generate all passwords directly in code (45 chars, alphanumeric)
const harborAdminPassword = generateRandomPassword();
const harborGithubUserPasswordLocal = generateRandomPassword();

// Reference keycloak stack for basic outputs (URL and user ID only)
export const keycloakStack = new pulumi.StackReference("egulatee/keycloak/dev");

// Get outputs from keycloak stack
export const keycloakAdminUserId = keycloakStack.requireOutput("keycloakAdminUserId");
export const keycloakUrl = keycloakStack.requireOutput("keycloak_url");
export const harborGithubEmail = keycloakStack.requireOutput("email");
// Use the actual Keycloak admin password for provider authentication
const keycloakAdminPasswordFromStack = keycloakStack.requireOutput("keycloakAdminPassword");

// Export passwords (using generated ones for new users, stack one for existing admin)
export const keycloakAdminPassword = keycloakAdminPasswordFromStack;
export const harborGithubUserPassword = harborGithubUserPasswordLocal;

// Create Keycloak provider using the actual admin password from Keycloak stack
const keycloakProvider = new keycloak.Provider("keycloak", {
    clientId: "admin-cli",
    username: keycloakAdminUserId,
    password: keycloakAdminPasswordFromStack,
    url: keycloakUrl,
    realm: "master",
});

// Create Harbor Keycloak realm and client
const harborRealmName = "Harbor";
const harborRealm = new keycloak.Realm(
    harborRealmName,
    {
        realm: harborRealmName,
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

// Create Harbor user and groups
// Get user ID from keycloak stack, but use locally generated password
const harborGithubUserId = keycloakStack.requireOutput("harbor_githubUserId");

const harborGithubUser = new keycloak.User(
    "harbor-github-user",
    {
        realmId: harborRealm.id,
        username: harborGithubUserId,
        firstName: "Harbor",
        lastName: "User",
        email: harborGithubEmail,
        emailVerified: true,
        initialPassword: {
            temporary: false,
            value: harborGithubUserPasswordLocal,
        },
    },
    { provider: keycloakProvider, dependsOn: [harborClient] }
);

// Create proxy cache project admin group
const harborProxyCacheProjectAdmin = new keycloak.Group(
    "proxycacheprojectadmin",
    {
        name: "proxycacheprojectadmin",
        realmId: harborRealm.id,
    },
    { provider: keycloakProvider, dependsOn: [harborClient] }
);

// Create AI augmented software development project admin group
const harborAiAugmentedProjectAdmin = new keycloak.Group(
    "aiaugmentedsoftwaredevprojectadmin",
    {
        name: "aiaugmentedsoftwaredevprojectadmin",
        realmId: harborRealm.id,
    },
    { provider: keycloakProvider, dependsOn: [harborClient] }
);

const harborProxyCacheProjectAdminMembership = new keycloak.UserGroups(
    "proxycacheprojectadmin_membership",
    {
        realmId: harborRealm.id,
        groupIds: [harborProxyCacheProjectAdmin.id],
        userId: harborGithubUser.id,
    },
    {
        provider: keycloakProvider,
        dependsOn: [harborClient, harborProxyCacheProjectAdmin, harborGithubUser],
    }
);

const harborAiAugmentedProjectAdminMembership = new keycloak.UserGroups(
    "aiaugmentedsoftwaredevprojectadmin_membership",
    {
        realmId: harborRealm.id,
        groupIds: [harborAiAugmentedProjectAdmin.id],
        userId: harborGithubUser.id,
    },
    {
        provider: keycloakProvider,
        dependsOn: [harborClient, harborAiAugmentedProjectAdmin, harborGithubUser],
    }
);

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

// Create Harbor instance
let harbor = new Harbor("harbor", {
    adminPassword: harborAdminPassword,
});

// Configure Harbor provider
let harborProvider = new pulumiharbor.Provider(
    "harborprovider",
    {
        url: "https://harbor.egyrllc.com",
        username: "admin",
        password: harborAdminPassword,
    },
    { dependsOn: [harbor, harbor.chart] }
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
    },
    {
        provider: harborProvider,
        dependsOn: [harbor],
    }
);

console.log("📋 Harbor Infrastructure deployed successfully!");
console.log("");
console.log("Next steps:");
console.log("1. Visit Harbor at: https://harbor.egyrllc.com");
console.log("2. Click 'LOGIN VIA OIDC' button");
console.log("3. Authenticate with Keycloak using the Harbor GitHub user credentials");
console.log("4. Once logged in successfully, deploy the harbor-permissions stack");
console.log("");
console.log("Harbor GitHub User Credentials:");
console.log(`   Username: ${harborGithubUserId}`);
console.log(`   Password: ${harborGithubUserPasswordLocal}`);

// Export Harbor registry information for external stack references
export const harborUrl = "https://harbor.egyrllc.com";
export const harborRegistryUrl = "harbor.egyrllc.com";
export const harborAdminPasswordExport = harborAdminPassword;
export const harborGithubUserName = harborGithubUserId;
export const harborGithubUserCredentials = harborGithubUserPasswordLocal;

// Export project information for permissions stack
export const realestateanalyzorProjectName = "realestateanalyzor";
export const proxyCacheProjectName = "proxy-cache";
export const aiaugmentedProjectName = "aiaugmentedsoftwaredev";

// Export OIDC information for permissions stack
export const oidcClientId = harborClient.clientId;
export const oidcClientSecret = harborClient.clientSecret;
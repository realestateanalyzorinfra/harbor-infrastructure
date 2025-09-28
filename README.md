# Harbor Infrastructure

This Pulumi TypeScript project deploys Harbor (container registry) infrastructure on Kubernetes using Helm, with integrated Keycloak OIDC authentication.

## Architecture

This is **Stack 1** of a two-stack Harbor deployment:

1. **harbor-infrastructure** (this repository) - Harbor deployment, OIDC setup, and projects
2. **harbor-permissions** - Project member assignments and CLI secrets

## Components Deployed

- **Harbor Container Registry** - Deployed via Helm chart
- **Keycloak Integration** - OIDC realm, client, users, and groups
- **Harbor Projects**:
  - `realestateanalyzor` - Private project with vulnerability scanning
  - `proxy-cache` - Private proxy cache project connected to DockerHub
  - `aiaugmentedsoftwaredev` - Private project with vulnerability scanning
- **OIDC Authentication** - Fully configured Harbor ⟷ Keycloak integration

## Prerequisites

- Kubernetes cluster with access via `egulatee/kubeconfig/dev` Pulumi stack
- Keycloak deployment via `egulatee/keycloak/dev` Pulumi stack
- Pulumi CLI installed and configured
- Node.js and npm

## Environment Variables

Create `.env.local` with:

```bash
PULUMI_ACCESS_TOKEN=your_pulumi_token
```

## Deployment

```bash
# Install dependencies
npm install

# Initialize Pulumi stack (if needed)
pulumi stack init dev

# Deploy infrastructure
pulumi up
```

## Outputs

Key outputs for use by harbor-permissions stack:

- `harborUrl` - Harbor registry URL
- `harborAdminPasswordExport` - Harbor admin password
- `harborGithubUserName` - OIDC user name
- `harborGithubUserCredentials` - OIDC user password
- Project names for permissions assignment

## Next Steps

After deployment:

1. Visit Harbor at: https://harbor.egyrllc.com
2. Test OIDC login with the provided credentials
3. Deploy the `harbor-permissions` stack for project access

## Configuration

- Harbor URL: `https://harbor.egyrllc.com`
- Kubernetes namespace: `harbor`
- OIDC endpoint: `https://keycloak.egyrllc.com/realms/Harbor`
- Storage class: `ceph-replicated`
- TLS: Managed by cert-manager with zerossl-prod

## Dependencies

- `egulatee/kubeconfig/dev` - Kubernetes cluster access
- `egulatee/keycloak/dev` - Keycloak server deployment
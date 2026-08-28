export function isPublishedProductionDeploy(context) {
  return context?.deploy?.context === "production"
    && context?.deploy?.published === true;
}

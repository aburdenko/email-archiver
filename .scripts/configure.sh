#!/bin/bash
# Usage: source .scripts/configure.sh
git config --global user.email "aburdenko@yahoo.com"
git config --global user.name "Alex Burdenko"

# Get the absolute path of the directory containing this script.
SCRIPT_DIR_CONFIGURE="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
# Try to get project from gcloud config, otherwise prompt the user.

# --- Load .env file if it exists ---
# This allows the .env file to be the primary source of configuration.
if [ -f ".env" ]; then
  echo "Loading environment variables from .env file..."
  # The `set -a` command automatically exports all variables that are subsequently defined.
  set -a
  source .env
  set +a
fi

# Determine PROJECT_ID and Google Credentials Setup
SERVICE_ACCOUNT_KEY_FILE="$SCRIPT_DIR_CONFIGURE/../../service_account.json"

# 1. Prioritize service account key file if it exists
# This logic is now secondary to the .env file.
if [ -f "$SERVICE_ACCOUNT_KEY_FILE" ]; then
  echo "Service account key found. Using its project ID for configuration."
  export GOOGLE_APPLICATION_CREDENTIALS="$SERVICE_ACCOUNT_KEY_FILE"
  PROJECT_ID=$(jq -r .project_id "$SERVICE_ACCOUNT_KEY_FILE")
  if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" == "null" ]; then
    echo "ERROR: Could not extract project_id from service account key file." >&2
    return 1
  fi
else
  echo "WARNING: Service account key file not found at '$SERVICE_ACCOUNT_KEY_FILE'."
  echo "Falling back to gcloud configuration or user input for Project ID."
  # Ensure GOOGLE_APPLICATION_CREDENTIALS is unset if no SA key, so ADC is used
  unset GOOGLE_APPLICATION_CREDENTIALS
fi

# 2. If PROJECT_ID not determined from service account, try gcloud config
if [ -z "$PROJECT_ID" ]; then
  CONFIGURED_PROJECT=$(gcloud config get-value project 2>/dev/null)
  if [ -n "$CONFIGURED_PROJECT" ]; then
    echo "Using configured gcloud project: $CONFIGURED_PROJECT"
    PROJECT_ID=$CONFIGURED_PROJECT
  fi
fi

# Check if the user is already logged in with ADC. If not, prompt them to log in.
# This avoids re-prompting for login on every `source`.
if ! gcloud auth application-default print-access-token &>/dev/null; then
  echo "User is not logged in. Running 'gcloud auth application-default login'..."
  # Prompt user to log in. This will set up Application Default Credentials (ADC).
  if ! gcloud auth application-default login --no-launch-browser --scopes=openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform; then
    echo "ERROR: gcloud auth application-default login failed." >&2
    return 1
  fi
else
  echo "User already logged in with Application Default Credentials."
fi

# 3. If still no PROJECT_ID, prompt the user with a helpful list of their projects.
if [ -z "$PROJECT_ID" ]; then
  echo "Could not determine gcloud project. Fetching available projects for you..."
  # Fetch projects and store them in an array.
  # The `read` command with a process substitution is a robust way to handle this.
  mapfile -t projects < <(gcloud projects list --format="value(projectId,name)" --sort-by=projectId)

  if [ ${#projects[@]} -eq 0 ]; then
    echo "No projects found for your account, or you may not have permission to list them."
    echo "Please enter your Google Cloud Project ID manually:"
    read -p "Project ID: " USER_INPUT_PROJECT_ID
    if [ -z "$USER_INPUT_PROJECT_ID" ]; then
      echo "ERROR: Project ID is required." >&2
      return 1
    fi
    PROJECT_ID=$USER_INPUT_PROJECT_ID
  else
    echo "Please select a project:"
    for i in "${!projects[@]}"; do
      printf "%3d) %s\n" "$((i+1))" "${projects[$i]}"
    done
    read -p "Enter number: " choice
    # Validate that the choice is a number and within the correct range.
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#projects[@]}" ]; then
      # Extract just the project ID from the selected line.
      PROJECT_ID=$(echo "${projects[$((choice-1))]}" | awk '{print $1}')
    else
      echo "ERROR: Invalid selection." >&2
      return 1
    fi
  fi
  echo "Setting active project to: $PROJECT_ID"
  gcloud config set project "$PROJECT_ID"
fi

# Export the final PROJECT_ID
export PROJECT_ID


# --- Project Configuration ---
# All project-wide configuration variables are set here.
# These are used by the various Python scripts in this project.
export GOOGLE_CLOUD_PROJECT=$PROJECT_ID # Also set this common env var for client libraries
export REGION="us-central1"

# Explicitly set the gcloud compute/region to ensure all gcloud commands and
# some client libraries default to the correct location.
gcloud config set compute/region $REGION

# Get your project number
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")

# The IAM service account the Cloud Function will run as.
# This is set to match the service account used for local testing to ensure consistent permissions.
export FUNCTION_SERVICE_ACCOUNT="${PROJECT_ID}@appspot.gserviceaccount.com"

export LOG_NAME="extract_pipeline_log"

# --- Document AI Configuration ---
export GCS_DOCUMENT_URI="gs://extract_pipeline_bucket" # The document to process.
export DOCAI_LOCATION="us" # The multi-region for the Document AI processor (e.g., 'us' or 'eu').
export PROCESSOR_ID="faf306856e4fe9b7"

export DOCAI_TIMEOUT=7200 # Timeout in seconds for Document AI batch jobs. Default is 2 hours.
export PROCESSOR_VERSION_ID="2cdafe7643d57775"
#export PROCESSOR_VERSION_ID="6d0304e3791c55fb"
#export PROCESSOR_VERSION_ID="cde-v1-2025-09-01"

# --- GCS Bucket & Docker Configuration for Pipelines ---
# IMPORTANT: Bucket names must be globally unique.
export SOURCE_GCS_BUCKET=$(echo $GCS_DOCUMENT_URI | sed 's#gs://##' | cut -d'/' -f1)
export STAGING_GCS_BUCKET="${PROJECT_ID}-staging" # Bucket for pipeline artifacts and staging files
export DOCKER_REPO="us-central1-docker.pkg.dev/${PROJECT_ID}/pipelines-repo" # Artifact Registry repo
export GCS_OUTPUT_URI="gs://${STAGING_GCS_BUCKET}/docai-output/" # Output for batch DocAI jobs
export GCS_RAG_TEXT_URI="gs://${SOURCE_GCS_BUCKET}/rag-engine-source-texts/" # Output for pre-processed text files for RAG Engine

# --- Vector Store Configuration ---
# IMPORTANT: Bucket names must be globally unique.
# Using your project ID in the bucket name is a good practice.
export INDEX_DISPLAY_NAME="extract_pipeline_bucket-store-index"
export INDEX_ENDPOINT_DISPLAY_NAME="extract_pipeline_bucket-vector-store-endpoint"
export EMBEDDING_MODEL_NAME="text-embedding-004"

# --- Virtual Environment Setup ---
if [ ! -d ".venv/python3.12" ]; then
  echo "Python virtual environment '.python3.12' not found."
  echo "Attempting to install python3-venv..."
  # Run apt-get update, but don't exit immediately on failure.
  # We capture the output to inspect it for specific, non-critical errors.
  update_output=$(sudo apt-get update 2>&1)
  update_exit_code=$?
  echo "$update_output" # Display the output to the user.

  if [ $update_exit_code -ne 0 ]; then
    # Check for the common, non-blocking "Release file" error.
    if echo "$update_output" | grep -q "does not have a Release file"; then
      echo "-------------------------------------------------------------------" >&2
      echo "WARNING: 'apt-get update' failed for a repository (e.g., 'baltocdn')." >&2
      echo "The script will attempt to continue, but you should fix the system's" >&2
      echo "repository list in '/etc/apt/sources.list.d/' for long-term stability." >&2
      echo "-------------------------------------------------------------------" >&2
    else
      # For other, more critical apt-get update errors, we stop.
      echo "-------------------------------------------------------------------" >&2
      echo "ERROR: 'sudo apt-get update' failed with a critical error." >&2
      echo "Please review the output above and resolve the system's APT issues before continuing." >&2
      echo "-------------------------------------------------------------------" >&2
      return 1 # Stop sourcing the script
    fi
  fi
  if ! sudo apt-get install -y python3.12-venv; then
    echo "-------------------------------------------------------------------" >&2
    echo "ERROR: Failed to install 'python3.12-venv'." >&2
    echo "This may be due to the 'apt-get update' issue above or other system problems." >&2
    echo "-------------------------------------------------------------------" >&2
    return 1
  fi

  echo "Creating Python virtual environment '.venv/python3.12'..."
  /usr/bin/python3 -m venv .venv/python3.12
  echo "Installing dependencies into .venv/python3.12 from requirements.txt..."

  echo "Granting Service Agent permissions on GCS buckets..."
  VERTEX_AI_SERVICE_AGENT="service-$PROJECT_NUMBER@gcp-sa-aiplatform.iam.gserviceaccount.com"
  # The default service agent used by Document AI for batch processing.
  DOCAI_SERVICE_AGENT="service-$PROJECT_NUMBER@gcp-sa-documentai.iam.gserviceaccount.com"
  # Grant the Vertex AI Service Agent permission to read from buckets
  # (Needed for creating Vector Search indexes from GCS)
  gcloud storage buckets add-iam-policy-binding gs://$SOURCE_GCS_BUCKET \
    --member="serviceAccount:$VERTEX_AI_SERVICE_AGENT" \
    --role="roles/storage.objectViewer"

  gcloud storage buckets add-iam-policy-binding gs://$STAGING_GCS_BUCKET \
    --member="serviceAccount:$VERTEX_AI_SERVICE_AGENT" \
    --role="roles/storage.objectViewer"

  gcloud services enable documentai.googleapis.com -q
  gcloud services enable aiplatform.googleapis.com -q
  # Enable the Google Picker API, which is required for the folder selection UI.
  gcloud services enable picker.googleapis.com -q

  # Grant the Document AI Service Agent permissions for batch processing
  gcloud storage buckets add-iam-policy-binding gs://$SOURCE_GCS_BUCKET --member="serviceAccount:$DOCAI_SERVICE_AGENT" --role="roles/storage.objectViewer" # Read input
  gcloud storage buckets add-iam-policy-binding gs://$STAGING_GCS_BUCKET --member="serviceAccount:$DOCAI_SERVICE_AGENT" --role="roles/storage.objectAdmin" # Write output

  echo "Granting the local service account permission to act as the function's service account..."
  # The service account from the JSON key needs the 'Service Account User' role
  # on the service account that the Vertex AI Custom Job will run as.
  if [ -f "$SERVICE_ACCOUNT_KEY_FILE" ]; then
    LOCAL_RUNNER_SA=$(jq -r .client_email "$SERVICE_ACCOUNT_KEY_FILE")
    MEMBER="serviceAccount:$LOCAL_RUNNER_SA"
    echo "Granting 'Service Account User' to SA: $LOCAL_RUNNER_SA"
  else
    # If using user credentials, grant the user the role.
    LOGGED_IN_USER=$(gcloud config get-value account)
    MEMBER="user:$LOGGED_IN_USER"
    echo "Granting 'Service Account User' to user: $LOGGED_IN_USER"
  fi
  gcloud iam service-accounts add-iam-policy-binding "$FUNCTION_SERVICE_ACCOUNT" \
    --member="$MEMBER" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT_ID"

  echo "Granting the function's service account the Vertex AI User role..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$FUNCTION_SERVICE_ACCOUNT" \
    --role="roles/aiplatform.user"

  echo "Granting the Apps Script user the Vertex AI User role for direct API calls..."
  # The user running the Apps Script needs this role to call the Gemini API directly.
  # The MEMBER variable was set above to either the user or the local SA.
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="$MEMBER" \
    --role="roles/aiplatform.user"

  # --- Ensure 'unzip' is installed for VSIX validation ---
  if ! command -v unzip &> /dev/null; then
    echo "'unzip' command not found. Attempting to install..."
    sudo apt-get update && sudo apt-get install -y unzip
  fi

  # --- Ensure 'jq' is installed for robust JSON parsing ---
  if ! command -v jq &> /dev/null; then
    echo "'jq' command not found. Attempting to install..."
    sudo apt-get update && sudo apt-get install -y jq
  fi

  # --- VS Code Extension Setup (One-time) ---
  echo "Checking for 'emeraldwalk.runonsave' VS Code extension..."
  # Use the full path to the executable, which we know from the environment
  CODE_OSS_EXEC="/opt/code-oss/bin/codeoss-cloudworkstations"

  if ! $CODE_OSS_EXEC --list-extensions | grep -q "emeraldwalk.runonsave"; then
    echo "Extension not found. Installing 'emeraldwalk.runonsave'..."

    # Using the static URL as requested. Note: This points to an older version (0.3.2)
    # and replaces the logic that dynamically finds the latest version.
    VSIX_URL="https://www.vsixhub.com/go.php?post_id=519&app_id=65a449f8-c656-4725-a000-afd74758c7e6&s=v5O4xJdDsfDYE&link=https%3A%2F%2Fmarketplace.visualstudio.com%2F_apis%2Fpublic%2Fgallery%2Fpublishers%2Femeraldwalk%2Fvsextensions%2FRunOnSave%2F0.3.2%2Fvspackage"
    VSIX_FILE="/tmp/emeraldwalk.runonsave.vsix" # Use /tmp for the download

    echo "Downloading extension from specified static URL..."
    # Use curl with -L to follow redirects and -o to specify output file
    # Add --fail to error out on HTTP failure and -A to specify a browser User-Agent
    if curl --fail -L -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/51.0.2704.103 Safari/537.36" -o "$VSIX_FILE" "$VSIX_URL"; then
      echo "Download complete. Installing..."
      # Add a check to ensure the downloaded file is a valid zip archive (.vsix)
      if unzip -t "$VSIX_FILE" &> /dev/null; then
        if $CODE_OSS_EXEC --install-extension "$VSIX_FILE"; then
          echo "Extension 'emeraldwalk.runonsave' installed successfully."
          echo "IMPORTANT: Please reload the VS Code window to activate the extension."
        else
          echo "Error: Failed to install the extension from '$VSIX_FILE'." >&2
        fi
      else
        echo "Error: Downloaded file is not a valid VSIX package. It may be an HTML page." >&2
        echo "Please check the VSIX_URL in the script or your network connection." >&2
      fi
      # Clean up the downloaded file
      rm -f "$VSIX_FILE" # This will run regardless of install success/failure
    else
      echo "Error: Failed to download the extension from '$VSIX_URL'." >&2
    fi
  else
    echo "Extension 'emeraldwalk.runonsave' is already installed."
  fi
else
  echo "Virtual environment '.python3.12' already exists."
fi

# --- Clasp (Apps Script) Setup ---
echo "Checking for Node.js and clasp..."
if ! command -v npm &> /dev/null; then
  echo "-------------------------------------------------------------------" >&2
  echo "WARNING: 'npm' (Node.js) is not installed, which is required for 'clasp'." >&2
  echo "The script will not be able to manage the Apps Script project." >&2
  echo "Please install Node.js and npm. On Debian/Ubuntu, you can run:" >&2
  echo "  sudo apt-get update && sudo apt-get install -y nodejs npm" >&2
  echo "-------------------------------------------------------------------" >&2
else
  # We need clasp >= 2.3.0 for the --no-launch-browser flag.
  # A robust way to check is to see if the flag exists in the help output.
  NEEDS_UPDATE=false
  if ! command -v clasp &> /dev/null; then
    echo "'clasp' command not found."
    NEEDS_UPDATE=true
  # The 'login' command might not exist on very old versions. If it fails,
  # the grep will also fail, correctly triggering an update.
  elif ! clasp login --help 2>/dev/null | grep -q -- '--no-localhost' || ! clasp --help 2>/dev/null | grep -q 'delete'; then
    echo "WARNING: Installed 'clasp' is outdated."
    echo "It needs to support the '--no-localhost' flag for login and the 'delete' command."
    NEEDS_UPDATE=true
  else
    CLASP_VERSION=$(clasp --version)
    echo "Found clasp version: $CLASP_VERSION."
    # The check for the '--no-localhost' flag is sufficient to ensure a modern version. We no longer need to check for pre-release tags.
  fi

  # *** FIX 1: Made installer more robust: UNINSTALL first, then INSTALL @latest ***
  if [ "$NEEDS_UPDATE" = true ]; then
    echo "Attempting to fix clasp installation (found unstable or outdated version)..."
    echo "First, uninstalling existing global clasp..."
    # Force uninstall whatever is currently installed
    sudo npm uninstall -g @google/clasp
    
    echo "Now, installing the latest STABLE version of 'clasp'..."
    # Use '@latest' explicitly to get the latest stable release.
    if ! sudo npm install -g @google/clasp@latest; then
      echo "ERROR: Failed to install 'clasp' globally via npm." >&2
      return 1 # This is a critical failure
    fi
  fi
fi

# Also ensure the main gcloud user is logged in. Some tools, including older
# versions of clasp, may look for these credentials instead of the Application
# Default Credentials. This provides a fallback.
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" &>/dev/null; then
  echo "-------------------------------------------------------------------"
  echo "INFO: Primary gcloud user is not logged in. Running 'gcloud auth login'..."
  echo "This is a fallback authentication method for 'clasp'."
  echo "-------------------------------------------------------------------"
  if ! gcloud auth login --no-launch-browser; then
    echo "ERROR: 'gcloud auth login' failed." >&2
    # This is not a fatal error, as ADC might still work.
  fi
fi

# Check for clasp login credentials and attempt to log in if needed.
# `clasp login --status` is the correct way to check for login without
# requiring a project to be configured.
if command -v clasp &> /dev/null && ! clasp login --status &>/dev/null; then
    echo "-------------------------------------------------------------------"
    echo "INFO: You are not logged into clasp. Attempting to log in..."
    echo ""
    echo "IMPORTANT: A browser window or tab will open for you to authorize 'clasp'."
    echo "After you approve, you will be redirected to a 'localhost' URL that will"
    echo "fail to load. THIS IS EXPECTED."
    echo ""
    echo "You must COPY the full URL from your browser's address bar (it will"
    echo "contain an authorization code) and PASTE it back into this terminal."
    echo ""
    echo "Example of the URL to copy: http://localhost:8888/?code=4/0A...&scope=..."
    echo "-------------------------------------------------------------------"
    
    # *** FIX 2: Removed obsolete '--gcloud' flag. ***
    # Modern 'clasp login' auto-detects the gcloud ADC environment.
    if ! clasp login --no-localhost; then
        echo "ERROR: 'clasp login' failed. The script may not be able to manage the Apps Script project." >&2
    fi
fi

if type deactivate &>/dev/null; then
  echo "Deactivating existing virtual environment..."
  deactivate
fi

echo "Activating environment './venv/python3.12'..."
 . .venv/python3.12/bin/activate

# Ensure dependencies are installed/updated every time the script is sourced.
# This prevents ModuleNotFoundError if requirements.txt changes after the
# virtual environment has been created.
echo "Ensuring dependencies from requirements.txt are installed..."
 # Use the full path to the venv pip to ensure we're installing in the correct environment.
./.venv/python3.12/bin/pip install -r requirements.txt > /dev/null

# --- Create .env file for python-dotenv ---
# This allows local development tools (like the functions-framework) to load
# environment variables without needing to source this script every time.
ENV_FILE=".env"
echo "Creating/updating ${ENV_FILE} for local development..."

# Use a temporary file to avoid issues, then move it into place.
TEMP_ENV_FILE=$(mktemp)

{
  echo "PROJECT_ID=${PROJECT_ID}"
  echo "GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}"
  echo "FUNCTION_SERVICE_ACCOUNT=${FUNCTION_SERVICE_ACCOUNT}"
  echo "REGION=${REGION}"
  echo "DOCAI_LOCATION=${DOCAI_LOCATION}"
  echo "PROCESSOR_ID=${PROCESSOR_ID}"
  echo "DOCAI_TIMEOUT=${DOCAI_TIMEOUT}"
  echo "PROCESSOR_VERSION_ID=${PROCESSOR_VERSION_ID}"
  echo "LOG_NAME=${LOG_NAME}"
  echo "DRIVE_SHARE_EMAIL=${DRIVE_SHARE_EMAIL}"
  echo "GEMINI_MODEL_NAME=${GEMINI_MODEL_NAME}"
  echo "JUDGEMENT_MODEL_NAME=${JUDGEMENT_MODEL_NAME}"
  echo "EMBEDDING_MODEL_NAME=${EMBEDDING_MODEL_NAME}"
  echo "SOURCE_GCS_BUCKET=${SOURCE_GCS_BUCKET}"
  echo "GCS_OUTPUT_URI=${GCS_OUTPUT_URI}"
  echo "GCS_RAG_TEXT_URI=${GCS_RAG_TEXT_URI}"
  echo "STAGING_GCS_BUCKET=${STAGING_GCS_BUCKET}"
  echo "DOCKER_REPO=${DOCKER_REPO}"
  echo "INDEX_DISPLAY_NAME=${INDEX_DISPLAY_NAME}"
  echo "INDEX_ENDPOINT_DISPLAY_NAME=${INDEX_ENDPOINT_DISPLAY_NAME}"
  echo "GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS}"
} > "$TEMP_ENV_FILE"
mv "$TEMP_ENV_FILE" "$ENV_FILE"


# --- Apps Script Deployment ---
# This section handles syncing the associated Google Apps Script project.
# It requires 'clasp' to be installed and for the user to be logged in.
# We use `clasp login --status` to check for a valid login session.
# This works even when using gcloud credentials (which don't create ~/.clasprc.json).
if command -v clasp &> /dev/null && clasp login --status &>/dev/null; then

  # --- Generate Sidebar.html from template ---
  # This creates the final HTML file for Apps Script from a template,
  # injecting project-specific details and default values.
  # The final Sidebar.html is git-ignored to protect sensitive data.
  SIDEBAR_TEMPLATE_FILE="apps-script/Sidebar.template.html"
  SIDEBAR_HTML_FILE="apps-script/Sidebar.html"

  if [ -f "$SIDEBAR_TEMPLATE_FILE" ]; then
    echo "Generating $SIDEBAR_HTML_FILE from template..."
    # 1. Copy the template to the final file
    cp "$SIDEBAR_TEMPLATE_FILE" "$SIDEBAR_HTML_FILE"

    # 2. Inject the GCP Project ID
    sed -i "s|__GCP_PROJECT_ID_PLACEHOLDER__|${PROJECT_ID}|g" "$SIDEBAR_HTML_FILE"

    # 3. Inject the Gemini API Key. Use the environment variable if it exists, otherwise use an empty string.
    sed -i "s|__GEMINI_API_KEY_PLACEHOLDER__|${GEMINI_API_KEY:-}|g" "$SIDEBAR_HTML_FILE"

    # 4. Inject the current datetime stamp in Eastern Time for version tracking.
    DATETIME_STAMP=$(TZ="America/New_York" date +"%Y-%m-%d %H:%M %Z")
    sed -i "s|__DATETIME_PLACEHOLDER__|${DATETIME_STAMP}|g" "$SIDEBAR_HTML_FILE"
  fi

  # Check that APP_SCRIPT_ID is set (it should be loaded from the .env file).
  # If it's not set, we can't proceed with clasp.
  if [ -z "$APP_SCRIPT_ID" ]; then
    echo "-------------------------------------------------------------------" >&2
    echo "ACTION REQUIRED: The 'APP_SCRIPT_ID' is not set." >&2
    echo "Please add the following line to your '.env' file:" >&2
    echo "" >&2
    echo "APP_SCRIPT_ID=\"YOUR_APPS_SCRIPT_ID_HERE\"" >&2
    echo "-------------------------------------------------------------------" >&2
    return 1 # Stop sourcing the script
  fi

  # Ensure the project is linked to the correct Apps Script ID
  if [ ! -f ".clasp.json" ] || ! grep -q "$APP_SCRIPT_ID" .clasp.json; then
    echo "Creating/updating .clasp.json to link to script ID: $APP_SCRIPT_ID"
    # This creates the .clasp.json file and sets a rootDir.
    # This means your Apps Script code will live in a subfolder named "apps-script".
    echo "{\"scriptId\":\"$APP_SCRIPT_ID\", \"rootDir\": \"apps-script\"}" > .clasp.json
    mkdir -p apps-script # Create the directory for your code

    echo "Performing one-time bootstrap to sync with the remote Apps Script project..."
    # This is a common issue: `clasp push` fails on a pre-existing project.
    # This sequence forces clasp to learn the remote file IDs without losing local changes.
    # 1. `pull --force` overwrites local files but syncs clasp's internal state.
    clasp pull --force
    # 2. `git checkout` immediately restores our local files, which are the source of truth.
    git checkout -- apps-script/
    echo "Bootstrap complete. You can now push changes."
  fi
  
  echo "Apps Script project linked successfully. You can now run 'clasp pull'."

fi
# This POSIX-compliant check ensures the script is sourced, not executed.
# (return 0 2>/dev/null) will succeed if sourced and fail if executed.
if ! (return 0 2>/dev/null); then
  echo "-------------------------------------------------------------------"
  echo "ERROR: This script must be sourced, not executed."
  echo "Usage: source .scripts/configure.sh"
  echo "-------------------------------------------------------------------"
  exit 1
fi

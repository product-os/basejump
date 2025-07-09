#!/bin/bash
set -euo pipefail

setup_gpg() {
    echo "Setting up GPG for automated commit signing..."

    # Validate required files/vars exist
    if [[ ! -f "$GPG_KEY_FILE" ]]; then
        echo "Error: No GPG key file found at $GPG_KEY_FILE" >&2
        exit 1
    fi

    import_key
    
    echo "GPG setup complete"
}

import_key() {
    echo "Importing GPG key..."

    local fingerprint
    local key_id
    
    # Import the key
    if ! gpg --batch --yes --import "$GPG_KEY_FILE"; then
        echo "Error: Failed to import GPG key" >&2
        exit 1
    fi
    
    # Get key info
    fingerprint=$(gpg --list-secret-keys --with-colons | grep '^fpr:' | head -n 1 | cut -d: -f10)
    key_id=$(gpg --list-secret-keys --with-colons | grep '^sec:' | head -n 1 | cut -d: -f5)
    
    if [[ -z "$fingerprint" || -z "$key_id" ]]; then
        echo "Error: Could not extract GPG key information after import" >&2
        exit 1
    fi
    
    # Set ultimate trust
    echo "$fingerprint:6:" | gpg --import-ownertrust
    
    echo "GPG key imported and configured: $key_id"
    export KEY_ID="$key_id"
}

setup_gpg

exec npm start
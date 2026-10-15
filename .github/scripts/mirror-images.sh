#!/usr/bin/env bash
# Copies every image of .github/mirrored-images into the organisation's registry, by digest.
#
#   mirror-images.sh LIST DESTINATION
#
# DESTINATION is the prefix of the copies, such as ghcr.io/work-shape/mirror. The caller is
# signed in to it (skopeo login). An image the destination already holds under its digest is
# left alone and nothing is pulled for it. One it does not hold is copied with all platforms
# from the first public registry that serves it, and the copy has the digest of the original.
set -euo pipefail

[[ $# -eq 2 ]] || { echo "usage: mirror-images.sh LIST DESTINATION" >&2; exit 2; }
list=$1 destination=${2%/}

# Where an official image of Docker Hub is served without a sign-in.
sources=(public.ecr.aws/docker/library mirror.gcr.io/library docker.io/library)

fail() {
  echo "mirror-images: $1" >&2
  [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::error title=Mirror images::$1"
  exit 1
}

copied=0 present=0
while read -r image digest rest; do
  [[ -n $image && $image != \#* ]] || continue
  [[ $image =~ ^[a-z0-9._/-]+:[A-Za-z0-9._-]+$ && $digest =~ ^sha256:[0-9a-f]{64}$ && -z $rest ]] \
    || fail "$list: not NAME:TAG DIGEST: $image $digest $rest"
  name=${image%%:*}
  if skopeo inspect --raw "docker://$destination/$name@$digest" >/dev/null 2>&1; then
    echo "mirror-images: $destination/$image holds $digest"
    present=$((present + 1))
    continue
  fi
  served=""
  for source in "${sources[@]}"; do
    if skopeo copy --all --preserve-digests --retry-times 2 \
      "docker://$source/$name@$digest" "docker://$destination/$image"; then
      served=$source
      break
    fi
    echo "mirror-images: $source did not serve $image" >&2
  done
  [[ -n $served ]] || fail "no registry served $image at $digest: ${sources[*]}"
  skopeo inspect --raw "docker://$destination/$name@$digest" >/dev/null \
    || fail "$destination/$image was copied from $served but is not there under $digest"
  echo "mirror-images: copied $image from $served to $destination/$image"
  copied=$((copied + 1))
done < "$list"

[[ $((copied + present)) -gt 0 ]] || fail "$list names no image"
echo "mirror-images: $copied copied, $present already there"

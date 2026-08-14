# StreamLift Worker — paste this into a Google Colab cell and run it

!pip install -q streamlift-worker
!pip install -q git+https://{{MEGAPY_PAT}}@github.com/shubhra92/megapy.git

!streamlift-worker \
  --worker-id    "{{WORKER_ID}}" \
  --auth-token   "{{AUTH_TOKEN}}" \
  --api-url      "{{API_BASE_URL}}" \
  --compute-type "{{COMPUTE_TYPE}}" \
  --location     "{{DOWNLOAD_LOCATION}}" \
  --pinggy-token "{{PINGGY_TOKEN}}"{{MEGA_FLAGS}}

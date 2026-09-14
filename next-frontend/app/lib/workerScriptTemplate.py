# StreamLift Worker — paste this into a Google Colab cell and run it

!pip install -q streamlift-worker
!pip install -q streamlift-megapy
!apt-get install -y -q aria2 > /dev/null

!streamlift-worker \
  --worker-id    "{{WORKER_ID}}" \
  --auth-token   "{{AUTH_TOKEN}}" \
  --api-url      "{{API_BASE_URL}}"

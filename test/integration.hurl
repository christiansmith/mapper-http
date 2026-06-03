# Integration smoke test for the example server (run.js): echo mapping, CORS open, no auth.
# Start the server first:  deno task dev
# Then run:                hurl --test test/integration.hurl

# Health check (unauthenticated)
GET http://localhost:3333/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"

# Run the echo mapping over an input
POST http://localhost:3333/map
Content-Type: application/json
{
  "mapping": "echo",
  "input": { "hello": "world" }
}
HTTP 200
[Asserts]
jsonpath "$.valid" == true
jsonpath "$.echo.hello" == "world"

# List registered mappings
GET http://localhost:3333/mappings
HTTP 200
[Asserts]
jsonpath "$.echo" exists

# Missing mapping is a 400
POST http://localhost:3333/map
Content-Type: application/json
{
  "input": {}
}
HTTP 400
[Asserts]
jsonpath "$.error" == "bad_request"

# Unknown route is a 404
GET http://localhost:3333/nope
HTTP 404

# CORS preflight
OPTIONS http://localhost:3333/map
Origin: http://localhost:5173
HTTP 204
[Asserts]
header "access-control-allow-origin" == "*"

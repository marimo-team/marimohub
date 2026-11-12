terraform {
  required_version = ">= 1.4.0"
}

variable "hub_url" {
  type = string
}

variable "hub_project_id" {
  type = string
}

variable "warehouse_host" {
  type = string
}

resource "terraform_data" "hub_integrations" {
  triggers_replace = {
    script  = filesha256("${path.module}/../deno/integrations.ts")
    config  = filesha256("${path.module}/../deno/deno.json")
    lock    = filesha256("${path.module}/../deno/deno.lock")
    hub     = var.hub_url
    project = var.hub_project_id
    host    = var.warehouse_host
  }

  provisioner "local-exec" {
    working_dir = "${path.module}/../deno"
    command     = "deno task apply"
    environment = {
      MARIMOHUB_URL        = var.hub_url
      MARIMOHUB_PROJECT_ID = var.hub_project_id
      WAREHOUSE_HOST       = var.warehouse_host
    }
  }
}

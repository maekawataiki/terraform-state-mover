variable "queue_url" {
  type = string
}

resource "aws_ecs_cluster" "worker" {
  name = "worker-cluster"
}

variable "vpc_id" {
  type = string
}

resource "aws_ecs_cluster" "app" {
  name = "app-cluster"
}
